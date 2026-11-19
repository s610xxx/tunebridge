package com.tunebridge.security;

import com.tunebridge.config.SecurityProperties;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;
import org.springframework.security.web.header.HeaderWriterFilter;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;

@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
@EnableConfigurationProperties(SecurityProperties.class)
public class SecurityConfiguration {
    private static final String[] STATIC_PATHS = {
            "/", "/index.html", "/styles.css", "/app.js", "/playlist-backup.js", "/favicon.ico"
    };
    private static final String CSP = "default-src 'self'; "
            + "script-src 'self' https://js-cdn.music.apple.com; "
            + "style-src 'self' 'unsafe-inline'; "
            + "connect-src 'self' https://api.music.apple.com https://play.music.apple.com "
            + "https://buy.music.apple.com https://amp-api.music.apple.com https://amp-api-edge.music.apple.com "
            + "https://itunes.apple.com https://music.apple.com; "
            + "frame-src https://authorize.music.apple.com https://music.apple.com; "
            + "img-src 'self' data: https://*.mzstatic.com https://y.gtimg.cn; "
            + "media-src 'self' blob: https://*.itunes.apple.com; "
            + "font-src 'self' https://js-cdn.music.apple.com; "
            + "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    @Bean
    PasswordEncoder passwordEncoder() {
        return Pbkdf2PasswordEncoder.defaultsForSpringSecurity_v5_8();
    }

    @Bean
    DeploymentPolicy deploymentPolicy(SecurityProperties properties, Environment environment) {
        return new DeploymentPolicy(properties, environment);
    }

    @Bean
    AuthRateLimiter authRateLimiter() {
        return new AuthRateLimiter();
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, DeploymentPolicy policy, AuthRateLimiter limiter)
            throws Exception {
        http.cors(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .requestCache(AbstractHttpConfigurer::disable)
                .csrf(csrf -> csrf.csrfTokenRepository(new HttpSessionCsrfTokenRepository())
                        .csrfTokenRequestHandler(new XorCsrfTokenRequestAttributeHandler()))
                .sessionManagement(session -> session.sessionFixation(fixation -> fixation.changeSessionId()))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.GET, STATIC_PATHS).permitAll()
                        .requestMatchers(HttpMethod.HEAD, STATIC_PATHS).permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/auth").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/auth/login", "/api/auth/register").permitAll()
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().denyAll())
                .exceptionHandling(exceptions -> exceptions
                        .authenticationEntryPoint((request, response, failure) ->
                                SecurityResponses.error(response, 401, "AUTH_REQUIRED"))
                        .accessDeniedHandler((request, response, failure) ->
                                SecurityResponses.error(response, 403, "CSRF_INVALID")))
                .formLogin(form -> form.loginPage("/api/auth").loginProcessingUrl("/api/auth/login")
                        .successHandler((request, response, authentication) -> {
                            response.setStatus(HttpServletResponse.SC_OK);
                            response.setContentType("application/json");
                            response.setHeader("Cache-Control", "no-store");
                            response.getWriter().write("{\"authenticated\":true}");
                        })
                        .failureHandler((request, response, failure) ->
                                SecurityResponses.error(response, 401, "LOGIN_FAILED")))
                .logout(logout -> logout
                        .logoutRequestMatcher(new AntPathRequestMatcher("/api/auth/logout", "POST"))
                        .invalidateHttpSession(true).clearAuthentication(true).deleteCookies("JSESSIONID")
                        .logoutSuccessHandler((request, response, authentication) -> {
                            response.setHeader("Cache-Control", "no-store");
                            response.setStatus(HttpServletResponse.SC_NO_CONTENT);
                        }))
                .headers(headers -> headers.frameOptions(frame -> frame.deny())
                        .contentTypeOptions(options -> { })
                        .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.NO_REFERRER))
                        .contentSecurityPolicy(csp -> csp.policyDirectives(CSP)));
        // Construct filters here rather than registering servlet Filter beans: each runs exactly once.
        // HeaderWriter precedes these filters so even rejected requests retain the security headers.
        http.addFilterAfter(new BoundaryFilter(policy, limiter), HeaderWriterFilter.class);
        http.addFilterAfter(new ApiBodyLimitFilter(), BoundaryFilter.class);
        http.addFilterBefore(new LoginGuardFilter(), UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
