package com.tunebridge.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.web.filter.OncePerRequestFilter;

final class BoundaryFilter extends OncePerRequestFilter {
    private final DeploymentPolicy policy;
    private final AuthRateLimiter limiter;

    BoundaryFilter(DeploymentPolicy policy, AuthRateLimiter limiter) {
        this.policy = policy;
        this.limiter = limiter;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (DeploymentPolicy.isApi(request)) {
            response.setHeader("Cache-Control", "no-store");
        }
        if (!policy.allows(request)) {
            SecurityResponses.error(response, 403, "BOUNDARY_REJECTED");
            return;
        }
        String path = DeploymentPolicy.path(request);
        if ((path.equals("/api/auth") || path.startsWith("/api/auth/"))
                && !limiter.allow(request.getRemoteAddr())) {
            response.setHeader("Retry-After", "60");
            SecurityResponses.error(response, 429, "RATE_LIMITED");
            return;
        }
        chain.doFilter(request, response);
    }
}
