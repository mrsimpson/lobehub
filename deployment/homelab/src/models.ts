// ---------------------------------------------------------------------------
// Model list helpers — fetched at Pulumi deploy time.
// Produces LobeHub MODEL_LIST env var strings: "-all,+id1,+id2,..."
// ---------------------------------------------------------------------------

type RawModel = {
  id: string
  pricing: { prompt: string; completion: string }
  supported_parameters?: string[]
}

const EXCLUDED = new Set(["openrouter/free", "openrouter/elephant-alpha"])
const OR_API = "https://openrouter.ai/api/v1/models"
const QUERY = "categories=programming&supported_parameters=tools&order=most-popular"

// ---------------------------------------------------------------------------
// OpenRouter — free models only
// ---------------------------------------------------------------------------

function toModelListEnv(ids: string[]): string {
  if (ids.length === 0) return ""
  return "-all," + ids.map((id) => `+${id}`).join(",")
}

async function fetchOrModels(): Promise<RawModel[]> {
  const res = await fetch(`${OR_API}?${QUERY}`)
  const data = (await res.json()) as { data: RawModel[] }
  return data.data
}

/** Fetch free OpenRouter models and return as OPENROUTER_MODEL_LIST value. */
export async function fetchFreeModelList(): Promise<string> {
  try {
    const models = await fetchOrModels()
    const ids = models
      .filter((m) => m.pricing.prompt === "0" && m.pricing.completion === "0")
      .filter((m) => !EXCLUDED.has(m.id) && !m.id.startsWith("google/lyria-") && !m.id.includes("guard"))
      .map((m) => m.id)
    return toModelListEnv(ids)
  } catch (e) {
    console.warn("Failed to fetch OpenRouter free models:", e)
    return ""
  }
}

// ---------------------------------------------------------------------------
// Flinker (llama.cpp) — OpenAI-compatible in-cluster endpoint
// ---------------------------------------------------------------------------

const FLINKER_BASE = "http://flinker:8080/v1"

/** Fetch models from flinker and return as LMSTUDIO_MODEL_LIST value.
 *
 * Each model is emitted with explicit capability flags using LobeHub's
 * extended model-list syntax: `id<maxToken:fc:reasoning>`
 *
 * Flinker runs llama.cpp which streams reasoning via `reasoning_content`
 * (same as DeepSeek). LobeHub's OpenAIStream handles this natively.
 */
export async function fetchFlinkerModelList(): Promise<string> {
  try {
    const res = await fetch(`${FLINKER_BASE}/models`)
    const data = (await res.json()) as { data: { id: string; meta?: { n_ctx_train?: number } }[] }
    const entries = data.data.map((m) => {
      const ctx = m.meta?.n_ctx_train ?? 32768
      return `+${m.id}<${ctx}:fc:reasoning>`
    })
    if (entries.length === 0) return ""
    return "-all," + entries.join(",")
  } catch {
    console.warn("flinker not reachable at deploy time — LMSTUDIO_MODEL_LIST will be empty")
    return ""
  }
}
