package com.tunebridge.web.dto;

import com.tunebridge.domain.ProviderConnection;

public record ConnectionView(
        boolean connected,
        String mode,
        String accountName
) {
    public static ConnectionView disconnected() {
        return new ConnectionView(false, null, null);
    }

    public static ConnectionView from(ProviderConnection connection) {
        if (connection == null) {
            return disconnected();
        }
        return new ConnectionView(true, connection.mode().name(), connection.accountName());
    }
}
