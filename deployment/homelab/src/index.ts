import * as pulumi from "@pulumi/pulumi"
import * as k8s from "@pulumi/kubernetes"
import { AuthType, createHomelabContextFromStack } from "@mrsimpson/homelab-core-components"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = "lobehub"
const NAMESPACE = APP_NAME
// lobehub runtime image exposes port 3210 (see root Dockerfile: ENV PORT="3210")
const APP_PORT = 3210

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config("lobehub")

// StackReference to the homelab base stack — provides tunnelCname, cloudflareZoneId, domain
const homelabStackName = cfg.get("homelabStack") ?? "mrsimpson/homelab/dev"
const homelabStack = new pulumi.StackReference(homelabStackName)

const domain = homelabStack.getOutput("domain") as pulumi.Output<string>

// Build HomelabContext from StackReference — homelab defaults apply
const homelab = createHomelabContextFromStack(homelabStack)

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

const lobehubImage = cfg.require("lobehubImage")
const storageSize = cfg.get("storageSize") ?? "2Gi"

// Required secrets
const databaseUrl = cfg.requireSecret("databaseUrl")
const authSecret = cfg.requireSecret("authSecret")
const keyVaultsSecret = cfg.requireSecret("keyVaultsSecret")

// Optional provider API keys — added to the env only when set
const openaiApiKey = cfg.getSecret("openaiApiKey")
const openrouterApiKey = cfg.getSecret("openrouterApiKey")
const anthropicApiKey = cfg.getSecret("anthropicApiKey")

// Optional OAuth provider credentials — added only when set
const authGoogleId = cfg.getSecret("authGoogleId")
const authGoogleSecret = cfg.getSecret("authGoogleSecret")

// ---------------------------------------------------------------------------
// 1. Namespace — pre-created with Pod Security Standards
// ---------------------------------------------------------------------------

const ns = new k8s.core.v1.Namespace(`${APP_NAME}-ns`, {
  metadata: {
    name: NAMESPACE,
    labels: {
      app: APP_NAME,
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/enforce-version": "latest",
      "pod-security.kubernetes.io/warn": "restricted",
      "pod-security.kubernetes.io/warn-version": "latest",
    },
  },
})

// ---------------------------------------------------------------------------
// 2. Secret — app env values (DB, auth, API keys)
// ---------------------------------------------------------------------------

const appSecret = new k8s.core.v1.Secret(
  `${APP_NAME}-env`,
  {
    metadata: {
      name: `${APP_NAME}-env`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: "Opaque",
    stringData: {
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      KEY_VAULTS_SECRET: keyVaultsSecret,
    },
  },
  { dependsOn: [ns] },
)

// ---------------------------------------------------------------------------
// 3. ExternalSecret — GHCR pull credentials
//    Created explicitly because ExposedWebApp only auto-creates it when the
//    namespace is created by the component itself. We pre-create the namespace.
// ---------------------------------------------------------------------------

const pullSecret = new k8s.apiextensions.CustomResource(
  `${APP_NAME}-ghcr-pull-secret`,
  {
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ExternalSecret",
    metadata: {
      name: "ghcr-pull-secret",
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    spec: {
      refreshInterval: "1h",
      secretStoreRef: {
        name: "pulumi-esc",
        kind: "ClusterSecretStore",
      },
      target: {
        name: "ghcr-pull-secret",
        creationPolicy: "Owner",
        template: {
          type: "kubernetes.io/dockerconfigjson",
          engineVersion: "v2",
          data: {
            ".dockerconfigjson": `{"auths":{"ghcr.io":{"username":"{{ .github_username }}","password":"{{ .github_token }}","auth":"{{ printf "%s:%s" .github_username .github_token | b64enc }}"}}}`,
          },
        },
      },
      data: [
        { secretKey: "github_username", remoteRef: { key: "github-username" } },
        { secretKey: "github_token", remoteRef: { key: "github-token" } },
      ],
    },
  },
  { dependsOn: [ns] },
)

// ---------------------------------------------------------------------------
// 4. Environment variables for the Deployment
//    Non-secret values inline; secret values pulled from the Kubernetes Secret.
// ---------------------------------------------------------------------------

const appDomain = pulumi.interpolate`${APP_NAME}.${domain}`

const baseEnv: { name: string; value: pulumi.Input<string> }[] = [
  { name: "APP_URL", value: pulumi.interpolate`https://${appDomain}` },
  { name: "DATABASE_DRIVER", value: "node" },
  { name: "NEXT_PUBLIC_SERVICE_MODE", value: "server" },
]

const optionalSecretEnv = (
  name: string,
  value: pulumi.Output<string> | undefined,
): { name: string; value: pulumi.Input<string> }[] =>
  value ? [{ name, value }] : []

const providerEnv = [
  ...optionalSecretEnv("OPENAI_API_KEY", openaiApiKey),
  ...optionalSecretEnv("OPENROUTER_API_KEY", openrouterApiKey),
  ...optionalSecretEnv("ANTHROPIC_API_KEY", anthropicApiKey),
  ...optionalSecretEnv("AUTH_GOOGLE_ID", authGoogleId),
  ...optionalSecretEnv("AUTH_GOOGLE_SECRET", authGoogleSecret),
]

// Secrets pulled directly from the env Secret so they are mounted, not inlined
const envFromSecret = [
  {
    secretRef: { name: `${APP_NAME}-env` },
  },
]

// ---------------------------------------------------------------------------
// 5. ExposedWebApp — Deployment, Service, OAuth2-Proxy auth, DNS, IngressRoute
// ---------------------------------------------------------------------------

export const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image: pulumi.output(lobehubImage),
    domain: appDomain,
    port: APP_PORT,
    replicas: 1,
    auth: AuthType.OAUTH2_PROXY,
    oauth2Proxy: { group: "developers" },
    imagePullSecrets: [{ name: "ghcr-pull-secret" }],
    securityContext: {
      runAsUser: 1001,
      runAsGroup: 1001,
      fsGroup: 1001,
    },
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "1000m", memory: "1Gi" },
    },
    env: [...baseEnv, ...providerEnv],
    envFrom: envFromSecret,
    probes: {
      readinessProbe: {
        httpGet: { path: "/", port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
        failureThreshold: 3,
      },
      livenessProbe: {
        httpGet: { path: "/", port: APP_PORT },
        initialDelaySeconds: 30,
        periodSeconds: 30,
        failureThreshold: 3,
      },
    },
    persistence: {
      enabled: true,
      size: storageSize,
      storageClass: "longhorn-uncritical",
      mountPath: "/app/data",
    },
    tags: ["lobehub", "chat", "ai"],
  },
  {
    dependsOn: [appSecret, pullSecret],
  },
)

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://${appDomain}`
export const namespace = app.namespace.metadata.name
