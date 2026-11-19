package com.tunebridge.security;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class SecurityResponses {
    private SecurityResponses() {
    }

    static void error(HttpServletResponse response, int status, String code) throws IOException {
        response.setStatus(status);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType("application/json");
        response.setHeader("Cache-Control", "no-store");
        String message = switch (code) {
            case "AUTH_REQUIRED" -> "请先登录音桥账号";
            case "LOGIN_FAILED" -> "账号或密码不正确";
            case "LOGOUT_REQUIRED" -> "请先退出当前账号后再登录";
            case "CSRF_INVALID" -> "安全令牌已失效，请刷新页面后手动重试；不会自动重发写入";
            case "BOUNDARY_REJECTED" -> "请求来源不受信任";
            case "RATE_LIMITED" -> "请求过于频繁，请稍后再试";
            case "REQUEST_TOO_LARGE" -> "请求内容过大";
            default -> "请求内容不受支持";
        };
        response.getWriter().write("{\"error\":\"" + message + "\",\"code\":\"" + code + "\"}");
    }
}
