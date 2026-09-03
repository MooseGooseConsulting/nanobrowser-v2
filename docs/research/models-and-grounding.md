# Models & Grounding for the Leader/Follower Browser Agent (OpenRouter)

_Research date: 2026-09-03. Live data pulled from `GET https://openrouter.ai/api/v1/models` (425 models, snapshot saved locally) plus OpenRouter docs, NVIDIA model cards, and GUI-grounding papers/repos. All numbers below are from that live pull or a cited URL — nothing here is from training-data memory of the OpenRouter catalog._

## Answer-first summary

1. **Leader (planner) default, free:** `nvidia/nemotron-3-ultra-550b-a55b:free` — large MoE, 1M context, `tools`+`reasoning`, on OpenRouter's free tier today.
2. **Follower (dom mode) default, free:** `nvidia/nemotron-3.5-lightning:free` — this is the model the user means by "nvidia lightning nemotron": text-only, 1M context, `tools`, speed-optimized (speculative decoding), released 2026-08-11.
3. **Follower (pixels/both mode) default, free:** `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — the only free OpenRouter model with vision+tools *and* an NVIDIA doc explicitly mentioning GUI/OCR support, but it is **not** a grounding-specialized model — treat its click coordinates as unproven and verify empirically.
4. There is **no dedicated GUI-grounding model (UI-TARS, GTA1, ShowUI, OS-Atlas) that is both free and reliable** on OpenRouter today. `bytedance/ui-tars-1.5-7b` is on OpenRouter and is very cheap ($0.10/$0.20 per 1M) but is **not free** and does not expose `tools`/`tool_choice` in `supported_parameters` — it emits its own action-language text, not OpenAI-style tool calls.
5. OpenRouter free-tier (`:free` suffix) rate limits: **50 requests/day, 20 req/min** with zero purchased credits; **1000 requests/day, 20 req/min** once you've purchased ≥$10 in credits (lifetime, doesn't expire). Source: openrouter.ai/docs/api_reference/limits and openrouter.ai/docs/faq.
6. Free models on OpenRouter may be served by providers whose data policy allows training on your prompts; this is enabled by default (`data_collection: "allow"`) and matters because your page DOM/screenshots would be sent. Set `provider.data_collection: "deny"` to restrict to non-training providers.
7. 21 models are currently `:free` or priced prompt=0/completion=0 on OpenRouter; 5 of them are NVIDIA Nemotron entries.
8. Pixel-mode grounding is a genuinely hard, actively-researched problem: best open models on ScreenSpot-Pro (high-res professional-app benchmark) are still under ~65% grounding accuracy; general-purpose VLMs (Gemma, MiniMax, dots) that aren't grounding-tuned typically caption rather than click precisely.
9. Anthropic's computer-use and OpenAI's computer-use-preview/GPT-5.6 both require the developer to declare a `display_width_px`/`display_height_px` and get coordinates back in *that* pixel space — you must downscale before sending and rescale the returned (x,y) back up; mismatches are the #1 cause of missed clicks.
10. Qwen2.5-VL returns **absolute pixel coordinates** in the resized-image space (must replicate its `smart_resize` exactly); Qwen3-VL switched to a **normalized 0–1000 grid**, a breaking change that has caused real grounding-accuracy regressions in GitHub issues when not handled.
11. Best cheap **paid** fallback for pixel/vision+tools follower: `qwen/qwen3-vl-8b-instruct` ($0.117/$0.455 per 1M) — Qwen-VL family has documented, cookbook-level coordinate-grounding support (see §5).
12. Best cheap paid Leader fallback with strong reasoning: `z-ai/glm-5.3-flash` ($0.075/$0.25, vision+tools, 1.3M ctx) or `deepseek/deepseek-v4-flash-0731` ($0.065/$0.18, tools, no vision) for pure-reasoning/dom-only leader work.

---

## 1. Free models on OpenRouter right now (`:free` id or $0/$0 pricing)

Pulled from `/api/v1/models` on 2026-09-03 (`https://openrouter.ai/api/v1/models`). 21 entries. "Vision" = `image` in `architecture.input_modalities`. "Tools" = `tools` in `supported_parameters`.

| id | context | vision | tools | structured_outputs | max completion |
|---|---|---|---|---|---|
| **nvidia/nemotron-3.5-lightning:free** ⭐ | 1,000,000 | no | yes | no | 65,536 |
| **nvidia/nemotron-3-ultra-550b-a55b:free** ⭐ | 1,000,000 | no | yes | no | 65,536 |
| **nvidia/nemotron-3-super-120b-a12b:free** ⭐ | 262,144 | no | yes | yes | 235,929 |
| **nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free** ⭐🖼 | 256,000 | yes (image/audio/video) | yes | no | 65,536 |
| **nvidia/nemotron-3.5-content-safety:free** ⭐🖼 | 128,000 | yes | no | no | 8,192 |
| dots-studio/dots-3-note-preview:free 🖼 | 512,000 | yes | yes | yes | 460,800 |
| minimax/minimax-m3:free 🖼 | 1,048,576 | yes (image/video) | yes | no | 943,718 |
| google/gemma-4-26b-a4b-it:free 🖼 | 262,144 | yes | yes | yes | 32,768 |
| google/gemma-4-31b-it:free 🖼 | 262,144 | yes | yes | yes | 32,768 |
| thinkingmachines/inkling:free 🖼 | 1,048,576 | yes (image/audio) | yes | no | 262,144 |
| thinkingmachines/inkling-small:free 🖼 | 1,048,576 | yes (image/audio) | yes | no | 262,144 |
| openrouter/free (meta-router) 🖼 | 200,000 | yes | yes | yes | n/a |
| z-ai/glm-5.2:free | 256,000 | no | yes | yes | 230,400 |
| minimax/minimax-m2.7:free | 196,608 | no | yes | no | 176,947 |
| inclusionai/ling-3.0-flash-fin:free | 262,144 | no | yes | no | 32,768 |
| liquid/lfm-2.5-2.6b:free | 65,536 | no | yes | yes | 8,192 |
| poolside/laguna-s-2.1:free | 262,144 | no | yes | no | 32,768 |
| poolside/laguna-xs-2.1:free | 262,144 | no | yes | no | 32,768 |
| cohere/north-mini-code:free | 256,000 | no | yes | no | 64,000 |
| google/lyria-3-pro-preview* | 1,048,576 | yes | no | no | 65,536 |
| google/lyria-3-clip-preview* | 1,048,576 | yes | no | no | 65,536 |

⭐ = NVIDIA Nemotron family. 🖼 = vision + tools together (the pixel-mode-capable free candidates). *lyria models are audio/media generation, not agentic chat — excluded from candidates.

## 2. Best FREE candidates by role

**(a) Follower, pixels/both mode (vision + tools required):**
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — vision+tools, NVIDIA's own docs (docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning) explicitly list "Graphical User Interface (GUI), Optical Character Recognition (OCR)" as capabilities, distinct from the other free vision options which are general chat/caption models with no stated grounding training.
- Runner-up: `dots-studio/dots-3-note-preview:free` (also has `structured_outputs`, useful for constraining click-coordinate JSON schema) or `minimax/minimax-m3:free` (video input, huge completion budget).
- Caveat: none of these publish ScreenSpot-Pro/OSWorld-G numbers — validate empirically before trusting in production.

**(b) Follower, dom mode (tools only, no vision needed):**
- `nvidia/nemotron-3.5-lightning:free` — purpose-built for "long-running autonomous agents, sub-agent workhorse deployments" per its own model card (build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard), 3B active params (fast/cheap to run), speculative decoding built in for low latency — exactly the profile a high-step-count navigator needs.
- Runner-up: `z-ai/glm-5.2:free` (has `structured_outputs`, useful for strict tool-call JSON).

**(c) Leader, strong reasoning + tools:**
- `nvidia/nemotron-3-ultra-550b-a55b:free` — largest free Nemotron (550B/55B active MoE), 1M context, `reasoning_effort` + `tools`.
- Runner-up: `nvidia/nemotron-3-super-120b-a12b:free` (smaller/cheaper compute, still has `structured_outputs` which Ultra lacks) or `z-ai/glm-5.2:free` (256K ctx, strong general reasoning brand, `structured_outputs`).

**Rate limits (verified):**
| Account state | Requests/day (free models) | Requests/minute |
|---|---|---|
| No credits purchased | 50 | 20 |
| ≥$10 credits purchased (lifetime, never expires) | 1,000 | 20 |
| Paid (non-`:free`) models | No OpenRouter-imposed cap; upstream provider may still throttle | — |

Sources: https://openrouter.ai/docs/api_reference/limits , https://openrouter.ai/docs/faq , https://openrouter.zendesk.com/hc/en-us/articles/39501163636379 , https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/ (all agree: 50/day free, 1000/day at $10+, 20 rpm both). A failed/rate-limited request still consumes one of the daily quota slots — build retry/backoff carefully, and prefer purchasing the $10 credit floor immediately given it's a one-time unlock.

## 3. Best cheap PAID fallbacks (from live pricing, $/1M tokens)

**Vision + tools (pixel-mode follower fallback), cheapest first:**
| id | in $/1M | out $/1M | context |
|---|---|---|---|
| nex-agi/nex-n2-mini | 0.025 | 0.10 | 262,144 |
| qwen/qwen3.7-flash | 0.03 | 0.13 | 1,000,000 |
| qwen/qwen3-vl-8b-instruct | 0.117 | 0.455 | ~131K–262K |
| google/gemma-3-12b-it | 0.05 | 0.15 | 131,072 |
| mistralai/mistral-small-3.2-24b-instruct | 0.075 | 0.20 | 131,072 |
| z-ai/glm-5.3-flash | 0.075 | 0.25 | 1,310,720 |

`qwen/qwen3-vl-8b-instruct` is the recommended paid fallback for pixels mode specifically because the Qwen-VL family (2.5 and 3) is the only line in this price band with a documented, maintained GUI-grounding/computer-use recipe (official cookbooks, see §5) rather than incidental vision support.

**Tools-only, dom-mode fallback, cheapest first:**
| id | in $/1M | out $/1M | context |
|---|---|---|---|
| mistralai/mistral-nemo | 0.019 | 0.03 | 131,072 |
| inclusionai/ling-3.0-flash | 0.021 | 0.063 | 262,144 |
| meta-llama/llama-3.1-8b-instruct | 0.05 | 0.08 | 131,072 |
| openai/gpt-oss-20b | 0.03 | 0.13 | 131,072 |
| deepseek/deepseek-v4-flash-0731 | 0.065 | 0.18 | 1,310,720 |
| openai/gpt-oss-120b | 0.037 | 0.17 | 131,072 |

**Strong reasoning (Leader fallback), from the reasoning-model sweep:**
| id | in $/1M | out $/1M | vision | context |
|---|---|---|---|---|
| deepseek/deepseek-v3.2 | 0.269 | 0.40 | no | 163,840 |
| qwen/qwen3-235b-a22b-2507 | 0.087 | 0.35 | no | 262,144 |
| z-ai/glm-5.3-flash | 0.075 | 0.25 | yes | 1,310,720 |
| deepseek/deepseek-chat-v3-0324 | 0.25 | 1.00 | no | 163,840 |
| moonshotai/kimi-k2-thinking | 0.60 | 2.50 | no | 262,144 |
| deepseek/deepseek-r1-0528 | 0.50 | 2.15 | no | 163,840 |

`z-ai/glm-5.3-flash` doubles as a vision-capable, cheap, high-context Leader fallback if you want the same model family for both roles.

## 4. NVIDIA Nemotron on OpenRouter today

Five Nemotron entries are live and free right now:

| id | params | context | vision | tools | notes |
|---|---|---|---|---|---|
| `nvidia/nemotron-3.5-lightning:free` | 30B total / 3B active MoE (Mamba-2+MoE+Attention hybrid) | 1M | no | yes | **This is the "Lightning" model** — released 2026-08-11 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 550B/55B active | 1M | no | yes | largest free Nemotron |
| `nvidia/nemotron-3-super-120b-a12b:free` | 120B/12B active | 262K | no | yes+structured | |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 30B/3B active | 256K | yes (image/audio/video) | yes | multimodal "perception sub-agent" |
| `nvidia/nemotron-3.5-content-safety:free` | — | 128K | yes | no | a safety classifier, not agentic |

There is also a non-free `nvidia/nemotron-3-nano-30b-a3b` (base, non-reasoning variant) and a "Nemotron 3 Nano Omni" catalog page distinct from the `:free` reasoning variant.

**What "Lightning" means:** Per NVIDIA's own model card (build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard) and the HF card (huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4), "Lightning" is a **speed-optimized branding**, not a separate model family — it's Nemotron 3.5 shipped together with several speculative-decoding methods (NVIDIA's own "DSpark", plus MTP and "DFlash") specifically to hit high tokens/sec for **long-running autonomous agents and sub-agent workhorse deployments**. The developer blog (developer.nvidia.com/blog/nvidia-nemotron-3-5-lightning-...) confirms it's available "through OpenRouter" directly. It is **text-only** — no vision — so it fits dom-mode navigation, not pixel-mode. This resolves the user's ambiguous "nvidia lightning nemotron" reference: they mean this exact model, `nvidia/nemotron-3.5-lightning:free`.

The vision-capable Nemotron, `nemotron-3-nano-omni-30b-a3b-reasoning`, is architecturally different (Nemotron-3-Nano-Omni: a Nemotron-3-Nano-30B-A3B LLM + CRADIO v4-H vision encoder + Parakeet speech encoder per docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning) and is explicitly positioned as a "perception and context sub-agent" that other agents call into, with GUI/OCR listed among its capabilities — but NVIDIA does not publish ScreenSpot/OSWorld-style grounding-accuracy numbers for it, so its click-coordinate reliability is unverified.

## 5. Pixel grounding: how current models return click coordinates

**Anthropic computer use** (claude.com/blog/best-practices-for-computer-and-browser-use-with-claude; github.com/anthropics/anthropic-quickstarts computer.py): the developer declares `display_width_px`/`display_height_px` on the `computer` tool; the model returns `coordinate: [x,y]` in that exact pixel space, not native screen resolution. The official demo recommends capping to XGA (1024×768), WXGA (1280×800), or FWXGA (1366×768) — "sizes above XGA/WXGA are not recommended." **Pre-downscaling the screenshot before sending is the single highest-impact fix for click accuracy**; images above internal API pixel limits are silently downscaled server-side, causing a coordinate-space mismatch if your harness doesn't downscale first and rescale the returned coordinates back up (`screen_x = api_x * screen_w/display_w`). Opus 4.7 raised the usable pixel budget (up to 3.75MP) versus 4.6, reducing how much downscaling is needed. A `enable_zoom` capability lets the model inspect a sub-region at higher resolution before clicking on dense UIs.

**OpenAI computer-use-preview / GPT-5.6 `computer` tool** (developers.openai.com/api/docs/guides/tools-computer-use): same shape — a `computer_call` action returns `x`,`y`; you send back a `computer_call_output` screenshot. GPT-5.6 preserves screenshot dimensions with `detail: "original"` (images >65,535px/side get scaled; >30,000 patches is rejected outright rather than resized) — recommended baseline resolutions 1440×900/1600×900. Community reports (community.openai.com/t/how-are-the-computer-use-api-coordinates-calculated) show the **older** `computer-use-preview` model silently assumed a standardized 1024×1024-ish space when the declared `display_width/height` didn't match the sent image — i.e., the same silent-downscale trap as Anthropic's, worse because it was undocumented.

**Qwen2.5-VL**: predicts **absolute pixel coordinates** in the post-`smart_resize` image space (factor=28, tunable `min_pixels`/`max_pixels`). Confirmed by the Qwen team on github.com/QwenLM/Qwen2.5-VL/issues/676. You must replicate the exact resize the model used, or coordinates won't map back correctly; theoretical grounding error is roughly ±1 patch-pixel once resize is correctly synchronized.

**Qwen3-VL**: switched to a **normalized 0–1000 relative grid**, independent of actual image resolution — this is confirmed directly by a Qwen3-VL maintainer on github.com/QwenLM/Qwen3-VL/issues/1521: "Qwen3-VL uses relative coordinates on a 1000×1000 grid... In the prompt, simply state: 'The screen's resolution is 1000×1000.'" This is a breaking change from 2.5-VL that has caused real regressions when developers ported 2.5-VL harnesses without updating the coordinate math (github.com/QwenLM/Qwen3-VL/issues/1780, /issues/1881).

**UI-TARS (ByteDance, github.com/bytedance/UI-TARS)**: purpose-built end-to-end GUI agent, trained via large-scale click-reward RL specifically for grounding. UI-TARS-1.5 scores **61.6% on ScreenSpot-Pro** and **42.5% on OSWorld** (full agentic task success), beating OpenAI CUA (23.4% / n/a) and Claude 3.7 (27.7%) *at the time of that comparison* — note Claude's computer-use has since improved substantially with Opus 4.6/4.7. `bytedance/ui-tars-1.5-7b` **is on OpenRouter** ($0.10/$0.20 per 1M, vision+text, 128K ctx) but its `supported_parameters` list has **no `tools`/`tool_choice`** — it emits actions in its own tagged text format, so a harness must parse that format rather than rely on OpenAI-style function calling.

**GTA1** (github.com/Yan98/GTA1, Salesforce): grounding-only model (7B/32B), current SOTA-class open grounding — GTA1-32B reaches **95.2% ScreenSpot-Pro-easy-variant / 65.2% OSWorld-G**; paired with an o3-class planner for full agentic tasks (45.2% OSWorld task success). **Not found on OpenRouter** — self-host from Hugging Face only.

**OS-Atlas, ShowUI**: earlier-generation open grounding models, used as baselines in the ScreenSpot-Pro paper (arxiv.org/pdf/2504.07981) — OS-Atlas-7B ~18.9% raw ScreenSpot-Pro (much lower without the paper's own "ScreenSeekeR" cascaded-search wrapper, which boosts it to 48.1%). Neither is on OpenRouter — self-host only.

**Benchmarks in brief:** ScreenSpot-Pro (gui-agent.github.io/grounding-leaderboard) is the hard, high-resolution/professional-app grounding benchmark — even current SOTA is well under 100% (best-in-class open models ~60-65%, per the GTA1 paper's own table). OSWorld (os-world.github.io) measures full agentic task success in a real Linux desktop, which is strictly harder than single-click grounding.

**Where free/cheap OpenRouter vision models stand:** none of the free vision+tools models found in §1 (dots-3-note, minimax-m3, gemma-4, inkling, nemotron-omni) publish ScreenSpot-Pro/OSWorld-G numbers — they are general-purpose multimodal chat/caption models, not grounding-tuned. Qwen-VL (2.5 and 3, cheap paid tier) is the only price-competitive family with an actively maintained, documented computer-use/grounding cookbook (github.com/QwenLM/Qwen3-VL cookbooks: `computer_use.ipynb`, `mobile_agent.ipynb`, `2d_grounding.ipynb`). Treat any free-tier vision model's click coordinates as captioning-quality, not grounding-quality, until validated against your own UI set.

## Recommendation

| Role | Mode | Default (free) | Reason | Paid fallback |
|---|---|---|---|---|
| **Leader** | any | `nvidia/nemotron-3-ultra-550b-a55b:free` | Largest free reasoning MoE on OpenRouter, 1M ctx, `tools`+`reasoning_effort` | `z-ai/glm-5.3-flash` ($0.075/$0.25, also vision-capable) or `deepseek/deepseek-v3.2` ($0.269/$0.40, strongest pure-reasoning per $ in the sweep) |
| **Follower** | dom | `nvidia/nemotron-3.5-lightning:free` | Purpose-built by NVIDIA for "long-running autonomous agents, sub-agent workhorse deployments"; speculative decoding for low per-step latency; this is the "lightning nemotron" the user asked about | `deepseek/deepseek-v4-flash-0731` ($0.065/$0.18) or `openai/gpt-oss-120b` ($0.037/$0.17) |
| **Follower** | pixels / both | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Only free OpenRouter model combining vision+tools with NVIDIA-documented GUI/OCR capability — **validate grounding accuracy empirically before relying on it** | `qwen/qwen3-vl-8b-instruct` ($0.117/$0.455) — only cheap-tier model with a maintained, documented coordinate-grounding cookbook; self-hosted `UI-TARS-1.5` or `GTA1` if you need SOTA grounding and can run your own inference (not on OpenRouter, or on OpenRouter without `tools` support for UI-TARS) |

**Wiring notes for LangChain `ChatOpenAI`:** point `baseURL` at `https://openrouter.ai/api/v1`, pass the OpenRouter API key as the OpenAI key, and add `provider: {allow_fallbacks: true, data_collection: "deny"}` in `model_kwargs`/`extra_body` if training-data exposure of page content is a concern (see Risks). Since free variants have low per-key RPM (20) and daily caps (50/1000), consider setting `provider.order` to pin a specific upstream host per model (free models can be served by multiple providers with different latency/availability) or accept OpenRouter's default load-balancing.

## Risks

- **Free-tier daily caps are small.** At 50 or even 1000 requests/day, a Follower doing many steps per browser task will exhaust the quota quickly in dev/test — budget for the $10 one-time credit purchase early, or route Follower traffic to a cheap paid model from day one.
- **A failed/rate-limited request still burns a daily-quota slot** — naive retry loops on `:free` models can exhaust the quota before completing a single task (per openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter).
- **Free models may be routed to providers that train on your prompts** by default (`data_collection: "allow"`). Since page DOM/screenshots are sent every step, set `data_collection: "deny"` (per-request or account-wide privacy setting) if this matters — this may reduce provider availability/increase latency for `:free` models.
- **No free/cheap model here has a published GUI-grounding benchmark score.** Pixel-mode click accuracy for every free candidate (including the recommended Nemotron Omni) is unverified — plan an empirical validation pass (e.g., a small internal ScreenSpot-style test set of your target site's screenshots) before shipping pixel mode on any free model.
- **UI-TARS-1.5-7B on OpenRouter has no `tools` support** in `supported_parameters` — if you want its strong grounding scores, you must parse its native `<action>`-tagged text output rather than use standard OpenAI-style function calling, which is extra integration work.
- **Qwen2.5-VL vs Qwen3-VL coordinate conventions are incompatible** (absolute-pixel vs normalized-0-1000) — if you swap between Qwen-VL generations for cost/quality reasons, the coordinate-rescaling code must change too, or clicks will silently land in the wrong place (documented regressions in QwenLM/Qwen3-VL issues #1780, #1881).
- **Free model catalog changes fast.** This snapshot is from 2026-09-03; NVIDIA's own Nemotron 3.5 Lightning card is dated 2026-08-11 (one month old at research time) — re-pull `/api/v1/models` before hard-coding ids into production config, and treat `openrouter/free` (the meta free-router) as a possible low-maintenance alternative to hand-picking a specific free id.
