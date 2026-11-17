package com.tunebridge.provider;

import org.springframework.http.HttpStatus;

public class ProviderException extends RuntimeException {

    private final String code;
    private final HttpStatus status;

    public ProviderException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public String code() {
        return code;
    }

    public HttpStatus status() {
        return status;
    }

    public static ProviderException badRequest(String message) {
        return new ProviderException(HttpStatus.BAD_REQUEST, "INVALID_INPUT", message);
    }

    public static ProviderException notConnected(String message) {
        return new ProviderException(HttpStatus.CONFLICT, "NOT_CONNECTED", message);
    }

    public static ProviderException unauthorized(String message) {
        return new ProviderException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", message);
    }

    public static ProviderException notConfigured(String message) {
        return new ProviderException(HttpStatus.SERVICE_UNAVAILABLE, "NOT_CONFIGURED", message);
    }

    public static ProviderException notFound(String message) {
        return new ProviderException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
    }

    public static ProviderException upstream(String message) {
        return new ProviderException(HttpStatus.BAD_GATEWAY, "UPSTREAM_ERROR", message);
    }

    public static ProviderException rateLimited(String message) {
        return new ProviderException(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", message);
    }
}
