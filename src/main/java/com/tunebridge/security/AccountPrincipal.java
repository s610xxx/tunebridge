package com.tunebridge.security;

import java.io.Serial;
import java.util.Collection;
import java.util.List;
import org.springframework.security.core.CredentialsContainer;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

public final class AccountPrincipal implements UserDetails, CredentialsContainer {
    @Serial
    private static final long serialVersionUID = 1L;

    private final String id;
    private final String username;
    private String passwordHash;

    public AccountPrincipal(String id, String username, String passwordHash) {
        this.id = id;
        this.username = username;
        this.passwordHash = passwordHash;
    }

    public String id() {
        return id;
    }

    public String username() {
        return username;
    }

    @Override
    public String getUsername() {
        return username;
    }

    @Override
    public String getPassword() {
        return passwordHash;
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of(new SimpleGrantedAuthority("ROLE_USER"));
    }

    @Override
    public void eraseCredentials() {
        passwordHash = null;
    }
}
