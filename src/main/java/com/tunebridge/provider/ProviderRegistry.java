package com.tunebridge.provider;

import com.tunebridge.domain.ProviderId;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class ProviderRegistry {

    private final Map<ProviderId, MusicProvider> providers = new EnumMap<>(ProviderId.class);

    public ProviderRegistry(List<MusicProvider> musicProviders) {
        for (MusicProvider provider : musicProviders) {
            providers.put(provider.id(), provider);
        }
    }

    public MusicProvider get(ProviderId id) {
        MusicProvider provider = providers.get(id);
        if (provider == null) {
            throw ProviderException.notConfigured("平台适配器未启用：" + id.label());
        }
        return provider;
    }
}
