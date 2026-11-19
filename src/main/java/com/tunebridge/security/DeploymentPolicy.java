package com.tunebridge.security;

import com.tunebridge.config.SecurityProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.core.env.Environment;

public final class DeploymentPolicy {
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");
    private final SecurityProperties.Mode mode;
    private final String publicOrigin;
    private final String publicAuthority;

    public DeploymentPolicy(SecurityProperties properties, Environment environment) {
        mode = properties.getMode();
        require(mode != null, "A valid security mode is required");
        require("none".equalsIgnoreCase(environment.getProperty("server.forward-headers-strategy", "none")),
                "Forwarded headers must be disabled; reverse proxies are not supported");
        if (mode == SecurityProperties.Mode.LOCAL) {
            require("127.0.0.1".equals(environment.getProperty("server.address")),
                    "Local mode requires server.address=127.0.0.1");
            publicOrigin = null;
            publicAuthority = null;
        } else {
            publicOrigin = validateOrigin(properties.getPublicOrigin());
            publicAuthority = URI.create(publicOrigin).getRawAuthority();
            require(environment.getProperty("server.ssl.enabled", Boolean.class, false),
                    "Public mode requires direct native TLS (server.ssl.enabled=true)");
            require(environment.getProperty("server.servlet.session.cookie.secure", Boolean.class, false),
                    "Public mode requires secure session cookies");
            String code = properties.getRegistrationCode();
            require(code != null && !code.isBlank() && code.length() >= 32 && code.length() <= 128,
                    "Public mode requires a registration code of 32 to 128 characters");
            for (String key : List.of("tunebridge.netease.pairing-code", "tunebridge.netease.node-executable",
                    "tunebridge.netease.cli-entry")) {
                require(environment.getProperty(key, "").isBlank(),
                        "Public mode forbids local NetEase pairing and CLI configuration");
            }
        }
    }

    public boolean allows(HttpServletRequest request) {
        for (String name : Collections.list(request.getHeaderNames())) {
            String lower = name.toLowerCase(Locale.ROOT);
            if (lower.equals("forwarded") || lower.startsWith("x-forwarded") || lower.equals("x-real-ip")) {
                return false;
            }
        }
        List<String> hosts = Collections.list(request.getHeaders("Host"));
        if (hosts.size() != 1) {
            return false;
        }
        String host = hosts.getFirst();
        String origin;
        if (mode == SecurityProperties.Mode.LOCAL) {
            if (!isLoopbackLiteral(request.getRemoteAddr()) || !isLoopbackLiteral(request.getLocalAddr())
                    || !localHostMatches(host, request.getLocalPort(), request.isSecure())) {
                return false;
            }
            origin = (request.isSecure() ? "https://" : "http://") + host;
        } else {
            if (!request.isSecure() || !publicAuthority.equals(host)) {
                return false;
            }
            origin = publicOrigin;
        }
        if (isApiMutation(request)) {
            List<String> origins = Collections.list(request.getHeaders("Origin"));
            if (origins.size() > 1 || (origins.size() == 1 && !origin.equals(origins.getFirst()))) {
                return false;
            }
            for (String site : Collections.list(request.getHeaders("Sec-Fetch-Site"))) {
                if (site.toLowerCase(Locale.ROOT).contains("cross-site")) {
                    return false;
                }
            }
        }
        return true;
    }

    static boolean isApiMutation(HttpServletRequest request) {
        return path(request).startsWith("/api/") && !SAFE_METHODS.contains(request.getMethod());
    }

    static boolean isApi(HttpServletRequest request) {
        return path(request).startsWith("/api/");
    }

    static String path(HttpServletRequest request) {
        return request.getRequestURI().substring(request.getContextPath().length());
    }

    private static boolean localHostMatches(String host, int port, boolean secure) {
        if (port < 1 || port > 65535) {
            return false;
        }
        for (String name : List.of("localhost", "127.0.0.1", "[::1]")) {
            if ((name + ":" + port).equals(host)
                    || (port == (secure ? 443 : 80) && name.equals(host))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isLoopbackLiteral(String address) {
        if (address == null || !(address.matches("127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}")
                || address.equals("::1") || address.equals("0:0:0:0:0:0:0:1"))) {
            return false;
        }
        try {
            // Only numeric literals pass the check above; this never performs a DNS lookup.
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (UnknownHostException ex) {
            return false;
        }
    }

    private static String validateOrigin(String value) {
        try {
            URI origin = URI.create(value);
            String host = origin.getHost();
            int port = origin.getPort();
            require("https".equals(origin.getScheme()) && host != null && !host.endsWith(".")
                            && host.equals(host.toLowerCase(Locale.ROOT)) && origin.getRawUserInfo() == null
                            && origin.getRawPath().isEmpty() && origin.getRawQuery() == null
                            && origin.getRawFragment() == null && (port == -1 || (port > 0 && port <= 65535 && port != 443)),
                    "Public origin must be canonical HTTPS without path, credentials, query, or fragment");
            String canonical = "https://" + host + (port == -1 ? "" : ":" + port);
            require(canonical.equals(value) && value.equals(origin.toASCIIString()),
                    "Public origin must be canonical HTTPS");
            return canonical;
        } catch (IllegalArgumentException | NullPointerException ex) {
            throw new IllegalStateException("A canonical public HTTPS origin is required", ex);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
