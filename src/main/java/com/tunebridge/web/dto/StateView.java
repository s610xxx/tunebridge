package com.tunebridge.web.dto;

import java.util.List;
import java.util.Map;

public record StateView(
        Map<String, ConnectionView> connections,
        List<ProviderView> providers,
        ConfigView config
) {
    public record ProviderView(String id, String label, String sampleUrl) {
    }

    public record ConfigView(
            boolean appleRealReady,
            boolean demoEnabled,
            String defaultStorefront,
            int maxTracks,
            String appleDeveloperToken
    ) {
    }
}
