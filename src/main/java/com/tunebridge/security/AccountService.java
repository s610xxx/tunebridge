package com.tunebridge.security;

import com.tunebridge.config.SecurityProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class AccountService implements UserDetailsService {
    private final JdbcTemplate jdbc;
    private final PasswordEncoder encoder;
    private final SecurityProperties properties;

    public AccountService(JdbcTemplate jdbc, PasswordEncoder encoder, SecurityProperties properties) {
        this.jdbc = jdbc;
        this.encoder = encoder;
        this.properties = properties;
    }

    @Override
    public AccountPrincipal loadUserByUsername(String username) throws UsernameNotFoundException {
        String normalized = normalizeUsername(username);
        if (normalized == null) {
            throw new UsernameNotFoundException("Login failed");
        }
        return jdbc.query("SELECT id, username, password_hash FROM app_users WHERE username = ?",
                        (rs, row) -> new AccountPrincipal(rs.getString("id"), rs.getString("username"),
                                rs.getString("password_hash")), normalized)
                .stream().findFirst().orElseThrow(() -> new UsernameNotFoundException("Login failed"));
    }

    public void register(String username, String password, String registrationCode) {
        String normalized = normalizeUsername(username);
        if (normalized == null || !validPasswordLength(password)
                || (registrationCode != null && registrationCode.length() > 128)
                || !registrationPermitted(registrationCode)) {
            throw new RegistrationRejectedException();
        }
        String hash = encoder.encode(password);
        try {
            jdbc.update("INSERT INTO app_users (id, username, password_hash) VALUES (?, ?, ?)",
                    UUID.randomUUID().toString(), normalized, hash);
        } catch (DuplicateKeyException ex) {
            // Do not disclose whether a username already exists, nor the database exception.
            throw new RegistrationRejectedException();
        }
    }

    private boolean registrationPermitted(String candidate) {
        if (properties.getMode() == SecurityProperties.Mode.LOCAL) {
            return true;
        }
        String expected = properties.getRegistrationCode();
        return expected != null && expected.length() >= 32 && candidate != null
                && MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                        candidate.getBytes(StandardCharsets.UTF_8));
    }

    public static String normalizeUsername(String username) {
        if (username == null || !username.matches("[A-Za-z0-9_]{3,32}")) {
            return null;
        }
        return username.toLowerCase(Locale.ROOT);
    }

    public static boolean validPasswordLength(String password) {
        return password != null && password.length() >= 12 && password.length() <= 128;
    }

    public static final class RegistrationRejectedException extends RuntimeException {
        public RegistrationRejectedException() {
            super("Registration could not be completed");
        }
    }
}
