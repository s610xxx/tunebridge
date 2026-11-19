package com.tunebridge.web;

import com.tunebridge.config.SecurityProperties;
import com.tunebridge.security.AccountPrincipal;
import com.tunebridge.security.AccountService;
import java.util.Locale;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AccountService accounts;
    private final SecurityProperties properties;

    public AuthController(AccountService accounts, SecurityProperties properties) {
        this.accounts = accounts;
        this.properties = properties;
    }

    @GetMapping
    public AuthView auth(Authentication authentication, CsrfToken csrfToken) {
        AccountPrincipal principal = authentication != null && authentication.isAuthenticated()
                && authentication.getPrincipal() instanceof AccountPrincipal account ? account : null;
        // Resolving the request attribute yields Spring's XOR token, not the raw session token.
        return new AuthView(principal != null, principal == null ? null : principal.username(),
                csrfToken.getToken(), csrfToken.getHeaderName(), true,
                properties.getMode() == SecurityProperties.Mode.PUBLIC,
                properties.getMode().name().toLowerCase(Locale.ROOT));
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(@RequestBody RegistrationRequest request) {
        try {
            accounts.register(request.username(), request.password(), request.registrationCode());
            return ResponseEntity.status(201).body(Map.of("registered", true));
        } catch (AccountService.RegistrationRejectedException ex) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "无法注册，请检查用户名、密码或邀请码，或更换用户名", "code", "REGISTRATION_FAILED"));
        }
    }

    public record AuthView(boolean authenticated, String username, String csrfToken, String csrfHeader,
                           boolean registrationAllowed, boolean registrationCodeRequired, String mode) {
    }

    public record RegistrationRequest(String username, String password, String registrationCode) {
        @Override
        public String toString() {
            return "RegistrationRequest[redacted]";
        }
    }
}
