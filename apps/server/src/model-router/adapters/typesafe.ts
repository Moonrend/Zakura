import type {
  ModelEvaluationInput,
  ModelEvaluationResult,
} from "@zakura/shared";
import type { ModelProtocolAdapter } from "../adapter.js";
import { httpJson, UpstreamHttpError } from "../http.js";

/**
 * TypeSafe System One（JEV）评估适配器。
 * 非对话协议：state + questions → 结构化答案（choice / noul / score）。
 * 端点：POST {baseUrl}/v1/systemone，Bearer 鉴权。
 */
export const typesafeAdapter: ModelProtocolAdapter = {
  protocol: "typesafe",
  supportedCapabilities: ["evaluation"],
  async evaluate(
    route,
    input: ModelEvaluationInput,
  ): Promise<ModelEvaluationResult> {
    const { baseUrl, apiKey, timeoutMs } = route.upstream.config;
    if (!apiKey) throw new Error("TypeSafe 上游缺少 API Key");
    const base = (baseUrl || "https://api.typesafe.ai").replace(/\/$/, "");
    const { ok, status, data, text } = await httpJson<{
      model?: string;
      answers?: ModelEvaluationResult["answers"];
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(`${base}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: input.state,
        model: route.model || "jev-latest",
        questions: input.questions,
      }),
      timeoutMs: timeoutMs ?? 20_000,
    });
    if (!ok) {
      throw new UpstreamHttpError(
        `TypeSafe API ${status}: ${text.slice(0, 200)}`,
        status,
      );
    }
    const answers = data?.answers ?? {};
    return {
      model: data?.model ?? route.model,
      answers,
      usage: data?.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens:
              (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  },
};
