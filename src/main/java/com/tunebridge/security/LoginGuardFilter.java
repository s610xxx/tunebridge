package com.tunebridge.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

final class LoginGuardFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if ("POST".equals(request.getMethod()) && DeploymentPolicy.path(request).equals("/api/auth/login")) {
            Authentication current = SecurityContextHolder.getContext().getAuthentication();
            if (current != null && current.isAuthenticated() && !(current instanceof AnonymousAuthenticationToken)) {
                SecurityResponses.error(response, 409, "LOGOUT_REQUIRED");
                return;
            }
            String[] usernames = request.getParameterValues("username");
            String[] passwords = request.getParameterValues("password");
            if (usernames == null || usernames.length != 1 || passwords == null || passwords.length != 1
                    || AccountService.normalizeUsername(usernames[0]) == null
                    || !AccountService.validPasswordLength(passwords[0])) {
                SecurityResponses.error(response, 401, "LOGIN_FAILED");
                return;
            }
        }
        chain.doFilter(request, response);
    }
}
