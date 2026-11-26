/**
 * 统一业务错误。状态码与 code 字符串逐一对齐 Java 侧 ProviderException + ApiExceptionHandler，
 * 因为前端 app.js 是按 code 分支处理的（AUTH_REQUIRED / CSRF_INVALID / TARGET_CHANGED）。
 */
export class ProviderApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProviderApiError";
    this.status = status;
    this.code = code;
  }

  static badRequest(message: string): ProviderApiError {
    return new ProviderApiError(400, "INVALID_INPUT", message);
  }

  static notConnected(message: string): ProviderApiError {
    return new ProviderApiError(409, "NOT_CONNECTED", message);
  }

  static unauthorized(message: string): ProviderApiError {
    return new ProviderApiError(401, "UNAUTHORIZED", message);
  }

  static notConfigured(message: string): ProviderApiError {
    return new ProviderApiError(503, "NOT_CONFIGURED", message);
  }

  static notFound(message: string): ProviderApiError {
    return new ProviderApiError(404, "NOT_FOUND", message);
  }

  static upstream(message: string): ProviderApiError {
    return new ProviderApiError(502, "UPSTREAM_ERROR", message);
  }

  /** 405 限流耗尽走这里：Java 侧新增的 rateLimited 保持同名同码。 */
  static rateLimited(message: string): ProviderApiError {
    return new ProviderApiError(429, "RATE_LIMITED", message);
  }

  /** 音桥账号未登录：前端见到 401 + AUTH_REQUIRED 才会清会话并提示，不能换成别的码。 */
  static authRequired(message = "请先登录 Qoder 账号"): ProviderApiError {
    return new ProviderApiError(401, "AUTH_REQUIRED", message);
  }

  static csrfInvalid(message = "安全令牌已失效，请刷新页面后手动重试；不会自动重发写入"): ProviderApiError {
    return new ProviderApiError(403, "CSRF_INVALID", message);
  }

  static conflict(code: string, message: string): ProviderApiError {
    return new ProviderApiError(409, code, message);
  }

  static methodNotAllowed(message = "请求方式不支持"): ProviderApiError {
    return new ProviderApiError(405, "METHOD_NOT_ALLOWED", message);
  }
}
