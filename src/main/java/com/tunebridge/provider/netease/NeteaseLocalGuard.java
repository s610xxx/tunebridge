package com.tunebridge.provider.netease;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Locale;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class NeteaseLocalGuard extends OncePerRequestFilter {

    private final NeteaseLocalAccess access;

    public NeteaseLocalGuard(NeteaseLocalAccess access) {
        this.access = access;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        if (!access.enabled()) {
            filterChain.doFilter(request, response);
            return;
        }

        String host = request.getHeader("Host");
        int port = request.getLocalPort();
        boolean validHost = host != null && (host.equalsIgnoreCase("localhost:" + port)
                || host.equals("127.0.0.1:" + port));
        String method = request.getMethod().toUpperCase(Locale.ROOT);
        boolean mutation = !method.equals("GET") && !method.equals("HEAD") && !method.equals("OPTIONS");
        String origin = request.getHeader("Origin");
        boolean validOrigin = !mutation || (host != null
                && (request.getScheme() + "://" + host).equalsIgnoreCase(origin));
        boolean crossSite = "cross-site".equalsIgnoreCase(request.getHeader("Sec-Fetch-Site"));
        boolean forwarded = request.getHeader("Forwarded") != null || request.getHeader("X-Forwarded-For") != null
                || request.getHeader("X-Forwarded-Host") != null || request.getHeader("X-Forwarded-Proto") != null
                || request.getHeader("X-Forwarded-Port") != null || request.getHeader("X-Real-IP") != null;
        if (!loopback(request.getRemoteAddr()) || !loopback(request.getLocalAddr())
                || !validHost || !validOrigin || crossSite || forwarded) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"error\":\"网易云本机模式仅允许本机同源访问\",\"code\":\"FORBIDDEN\"}");
            return;
        }

        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        filterChain.doFilter(request, response);
    }

    private static boolean loopback(String address) {
        try {
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (UnknownHostException ex) {
            return false;
        }
    }
}
