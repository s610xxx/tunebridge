package com.tunebridge.domain;

import java.util.Map;

public record ProviderConnection(
        ProviderId provider,
        ConnectionMode mode,
        String accountName,
        Map<String, String> credentials
) {
    public ProviderConnection {
        credentials = credentials == null ? Map.of() : Map.copyOf(credentials);
    }

    public String credential(String key) {
        return credentials.get(key);
    }
}
