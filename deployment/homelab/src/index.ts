import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import { AuthType, createHomelabContextFromStack } from '@mrsimpson/homelab-core-components';
import { fetchFreeModelList, fetchFlinkerModelList } from './models';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = 'lobehub';
const NAMESPACE = APP_NAME;
// lobehub runtime image exposes port 3210 (see root Dockerfile: ENV PORT="3210")
const APP_PORT = 3210;
const PG_PORT = 5432;
const PG_DB = 'lobehub';
const PG_USER = 'postgres';
// paradedb = Postgres 17 with pgvector + search_path extensions preloaded.
// lobehub requires pgvector, so the stock postgres image won't work.
const PG_IMAGE = 'paradedb/paradedb:latest-pg17';
const PG_STORAGE_CLASS = 'longhorn-uncritical';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = new pulumi.Config('lobehub');

// StackReference to the homelab base stack — provides tunnelCname, cloudflareZoneId, domain
const homelabStackName = cfg.get('homelabStack') ?? 'mrsimpson/homelab/dev';
const homelabStack = new pulumi.StackReference(homelabStackName);

const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;

const homelab = createHomelabContextFromStack(homelabStack);

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

const lobehubImage = cfg.require('lobehubImage');
const appStorageSize = cfg.get('storageSize') ?? '2Gi';
const dbStorageSize = cfg.get('databaseStorageSize') ?? '10Gi';

// Required secrets (app-side)
const authSecret = cfg.requireSecret('authSecret');
const keyVaultsSecret = cfg.requireSecret('keyVaultsSecret');
const jwksKey = cfg.requireSecret('jwksKey');

// S3 object storage (required for file uploads / knowledge base)
const s3AccessKeyId = cfg.requireSecret('s3AccessKeyId');
const s3SecretAccessKey = cfg.requireSecret('s3SecretAccessKey');
const s3Endpoint = cfg.require('s3Endpoint');
const s3Bucket = cfg.require('s3Bucket');

// Optional: external DATABASE_URL override. When set, the in-cluster Postgres
// StatefulSet is skipped and the app points at the provided URL.
const externalDatabaseUrl = cfg.getSecret('databaseUrl');

// Optional provider API keys — added to the env only when set
const openaiApiKey = cfg.getSecret('openaiApiKey');
const openrouterApiKey = cfg.requireSecret('openrouterApiKey');
const anthropicApiKey = cfg.getSecret('anthropicApiKey');

// Memory / embeddings — opt-in; requires nomic-embed-text-v1.5 on flinker:8081
const enableMemory = cfg.getBoolean('enableMemory') ?? false;

// GitHub OAuth — required for SSO login
const authGithubId = cfg.requireSecret('authGithubId');
const authGithubSecret = cfg.requireSecret('authGithubSecret');

// Optional OAuth provider credentials — added only when set
const authGoogleId = cfg.getSecret('authGoogleId');
const authGoogleSecret = cfg.getSecret('authGoogleSecret');

// ---------------------------------------------------------------------------
// 1. Namespace — pre-created with Pod Security Standards
// ---------------------------------------------------------------------------

const ns = new k8s.core.v1.Namespace(`${APP_NAME}-ns`, {
  metadata: {
    name: NAMESPACE,
    labels: {
      'app': APP_NAME,
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/enforce-version': 'latest',
      'pod-security.kubernetes.io/warn': 'restricted',
      'pod-security.kubernetes.io/warn-version': 'latest',
    },
  },
});

// ---------------------------------------------------------------------------
// 2. In-cluster Postgres (paradedb) — optional; skipped when externalDatabaseUrl is set
// ---------------------------------------------------------------------------

const deployInCluster = externalDatabaseUrl === undefined;

const pgPassword = new random.RandomPassword(
  `${APP_NAME}-pg-password`,
  { length: 32, special: false },
  { retainOnDelete: true },
);

const pgServiceHost = `${APP_NAME}-postgres`;
const pgConnectionUrl = pulumi.interpolate`postgres://${PG_USER}:${pgPassword.result}@${pgServiceHost}:${PG_PORT}/${PG_DB}`;

const pgSecret = deployInCluster
  ? new k8s.core.v1.Secret(
      `${APP_NAME}-postgres-credentials`,
      {
        metadata: {
          name: `${APP_NAME}-postgres-credentials`,
          namespace: NAMESPACE,
          labels: { app: APP_NAME, component: 'postgres' },
        },
        type: 'Opaque',
        stringData: {
          POSTGRES_DB: PG_DB,
          POSTGRES_USER: PG_USER,
          POSTGRES_PASSWORD: pgPassword.result,
        },
      },
      { dependsOn: [ns] },
    )
  : undefined;

const pgService = deployInCluster
  ? new k8s.core.v1.Service(
      `${APP_NAME}-postgres-svc`,
      {
        metadata: {
          name: pgServiceHost,
          namespace: NAMESPACE,
          labels: { app: APP_NAME, component: 'postgres' },
        },
        spec: {
          type: 'ClusterIP',
          ports: [{ name: 'postgres', port: PG_PORT, targetPort: PG_PORT }],
          selector: { component: 'postgres' },
        },
      },
      { dependsOn: [ns] },
    )
  : undefined;

const pgStatefulSet = deployInCluster
  ? new k8s.apps.v1.StatefulSet(
      `${APP_NAME}-postgres`,
      {
        metadata: {
          name: `${APP_NAME}-postgres`,
          namespace: NAMESPACE,
          labels: { app: APP_NAME, component: 'postgres' },
        },
        spec: {
          serviceName: pgServiceHost,
          replicas: 1,
          selector: { matchLabels: { component: 'postgres' } },
          template: {
            metadata: { labels: { component: 'postgres' } },
            spec: {
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 999,
                runAsGroup: 999,
                fsGroup: 999,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'postgres',
                  image: PG_IMAGE,
                  ports: [{ name: 'postgres', containerPort: PG_PORT }],
                  envFrom: [{ secretRef: { name: `${APP_NAME}-postgres-credentials` } }],
                  env: [
                    // paradedb image writes into /var/lib/postgresql/data by default;
                    // use a subdir so lost+found in the mount root doesn't break initdb.
                    { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                  ],
                  volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
                  readinessProbe: {
                    exec: { command: ['pg_isready', '-U', PG_USER, '-d', PG_DB] },
                    initialDelaySeconds: 10,
                    periodSeconds: 10,
                    failureThreshold: 6,
                  },
                  livenessProbe: {
                    exec: { command: ['pg_isready', '-U', PG_USER, '-d', PG_DB] },
                    initialDelaySeconds: 30,
                    periodSeconds: 30,
                    failureThreshold: 6,
                  },
                  securityContext: {
                    runAsNonRoot: true,
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                    seccompProfile: { type: 'RuntimeDefault' },
                  },
                  resources: {
                    requests: { cpu: '100m', memory: '256Mi' },
                    limits: { cpu: '1000m', memory: '1Gi' },
                  },
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: 'data' },
              spec: {
                accessModes: ['ReadWriteOnce'],
                storageClassName: PG_STORAGE_CLASS,
                resources: { requests: { storage: dbStorageSize } },
              },
            },
          ],
        },
      },
      { dependsOn: [pgService!, pgSecret!] },
    )
  : undefined;

// DATABASE_URL — external override wins; otherwise use the in-cluster URL
const databaseUrl: pulumi.Output<string> = externalDatabaseUrl ?? pgConnectionUrl;

// ---------------------------------------------------------------------------
// 3. Secret — app env values (DB, auth)
// ---------------------------------------------------------------------------

const appSecret = new k8s.core.v1.Secret(
  `${APP_NAME}-env`,
  {
    metadata: {
      name: `${APP_NAME}-env`,
      namespace: NAMESPACE,
      labels: { app: APP_NAME },
    },
    type: 'Opaque',
    stringData: {
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: authSecret,
      KEY_VAULTS_SECRET: keyVaultsSecret,
      JWKS_KEY: jwksKey,
      S3_ACCESS_KEY_ID: s3AccessKeyId,
      S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
      AUTH_GITHUB_ID: authGithubId,
      AUTH_GITHUB_SECRET: authGithubSecret,
      OPENROUTER_API_KEY: openrouterApiKey,
    },
  },
  { dependsOn: [ns] },
);

// GHCR pull secret is now auto-created by ExposedWebApp when imagePullSecrets
// references "ghcr-pull-secret" — no manual ExternalSecret needed.

// ---------------------------------------------------------------------------
// 4. Env wiring — non-secret inline values + optional provider keys
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const appDomain = pulumi.interpolate`${APP_NAME}.${domain}`;

// Fetch model lists at deploy time
const freeModelList = pulumi.output(fetchFreeModelList());
const flinkerModelList = pulumi.output(fetchFlinkerModelList());

const baseEnv: { name: string; value: string | pulumi.Output<string> }[] = [
  { name: 'APP_URL', value: pulumi.interpolate`https://${appDomain}` },
  { name: 'AUTH_TRUSTED_ORIGINS', value: pulumi.interpolate`https://${appDomain}` },
  { name: 'DATABASE_DRIVER', value: 'node' },
  { name: 'S3_ENDPOINT', value: s3Endpoint },
  { name: 'S3_BUCKET', value: s3Bucket },
  // Auth: GitHub SSO only, email/password disabled
  { name: 'AUTH_SSO_PROVIDERS', value: 'github' },
  { name: 'AUTH_DISABLE_EMAIL_PASSWORD', value: '1' },
  // OpenRouter — free models only (list built at deploy time)
  { name: 'OPENROUTER_MODEL_LIST', value: freeModelList },
  // Flinker (llama.cpp) — OpenAI-compatible in-cluster endpoint via lmstudio provider.
  // lmstudio is purpose-built for local inference servers: it never defaults to the
  // Responses API (unlike the openai provider), uses plain Chat Completions, and
  // handles reasoning_content + <think> tags via the shared OpenAIStream transformer.
  // A non-empty key is required to activate the provider; llama.cpp ignores its value.
  { name: 'LMSTUDIO_API_KEY', value: 'not-needed' },
  { name: 'LMSTUDIO_PROXY_URL', value: 'http://flinker:8080/v1' },
  { name: 'LMSTUDIO_MODEL_LIST', value: flinkerModelList },
  // Memory / embeddings — controlled by lobehub:enableMemory config flag
  ...(enableMemory
    ? [
        // nomic-embed-text-v1.5 on flinker:8081 (separate llama-server instance)
        { name: 'MEMORY_USER_MEMORY_EMBEDDING_BASE_URL', value: 'http://flinker:8081/v1' },
        { name: 'MEMORY_USER_MEMORY_EMBEDDING_MODEL', value: 'nomic-embed-text-v1.5.Q8_0.gguf' },
        { name: 'MEMORY_USER_MEMORY_EMBEDDING_PROVIDER', value: 'openai' },
        { name: 'MEMORY_USER_MEMORY_EMBEDDING_API_KEY', value: 'sk-dummy' },
        {
          name: 'DEFAULT_FILES_CONFIG',
          value: 'embedding_model=openai/nomic-embed-text-v1.5.Q8_0.gguf',
        },
      ]
    : [{ name: 'ENABLED_KNOWLEDGE_BASE', value: '0' }]),
];

const optionalSecretEnv = (
  name: string,
  value: pulumi.Output<string> | undefined,
): { name: string; value: string | pulumi.Output<string> }[] => (value ? [{ name, value }] : []);

const providerEnv = [
  ...optionalSecretEnv('OPENAI_API_KEY', openaiApiKey),
  ...optionalSecretEnv('ANTHROPIC_API_KEY', anthropicApiKey),
  ...optionalSecretEnv('AUTH_GOOGLE_ID', authGoogleId),
  ...optionalSecretEnv('AUTH_GOOGLE_SECRET', authGoogleSecret),
];

// ---------------------------------------------------------------------------
// 5. ExposedWebApp — Deployment, Service, OAuth2-Proxy auth, IngressRoute
// ---------------------------------------------------------------------------

const appDependsOn: pulumi.Resource[] = [appSecret];
if (pgStatefulSet) appDependsOn.push(pgStatefulSet);

export const app = homelab.createExposedWebApp(
  APP_NAME,
  {
    namespace: ns,
    image: pulumi.output(lobehubImage),
    domain: appDomain,
    port: APP_PORT,
    replicas: 1,
    auth: AuthType.OAUTH2_PROXY,
    oauth2Proxy: { group: 'users' }, // LobeHub Better Auth uses same GitHub App => this restricts the user group
    imagePullSecrets: [{ name: 'ghcr-pull-secret' }],
    securityContext: {
      runAsUser: 1001,
      runAsGroup: 1001,
      fsGroup: 1001,
    },
    resources: {
      requests: { cpu: '100m', memory: '256Mi' },
      limits: { cpu: '1000m', memory: '1Gi' },
    },
    env: [...baseEnv, ...providerEnv],
    envFrom: [{ secretRef: { name: `${APP_NAME}-env` } }],
    probes: {
      readinessProbe: {
        httpGet: { path: '/', port: APP_PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
        failureThreshold: 3,
      },
      livenessProbe: {
        httpGet: { path: '/', port: APP_PORT },
        initialDelaySeconds: 30,
        periodSeconds: 30,
        failureThreshold: 3,
      },
    },
    storage: {
      size: appStorageSize,
      storageClass: 'longhorn-uncritical',
      mountPath: '/app/data',
    },
    tags: ['lobehub', 'chat', 'ai'],
  },
  { dependsOn: appDependsOn },
);

// ---------------------------------------------------------------------------
// Stack outputs
// ---------------------------------------------------------------------------

export const url = pulumi.interpolate`https://${appDomain}`;
export const namespace = app.namespace.metadata.name;
export const databaseHost = deployInCluster ? pgServiceHost : 'external';
