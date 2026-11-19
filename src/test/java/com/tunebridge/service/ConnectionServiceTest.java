package com.tunebridge.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderRegistry;
import com.tunebridge.provider.netease.NeteaseLocalAccess;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;

class ConnectionServiceTest {

    @Test
    void revokesNeteaseGrantsOnDisconnectAndSessionExpiry() {
        ProviderRegistry registry = mock(ProviderRegistry.class);
        MusicProvider provider = mock(MusicProvider.class);
        NeteaseLocalAccess access = mock(NeteaseLocalAccess.class);
        when(registry.get(ProviderId.NETEASE_MUSIC)).thenReturn(provider);
        when(provider.connectReal(anyMap()))
                .thenReturn(new ProviderConnection(ProviderId.NETEASE_MUSIC, ConnectionMode.REAL,
                        "本机账号", Map.of("neteaseGrant", "first")))
                .thenReturn(new ProviderConnection(ProviderId.NETEASE_MUSIC, ConnectionMode.REAL,
                        "本机账号", Map.of("neteaseGrant", "second")));
        ConnectionService service = new ConnectionService(registry, access);
        MockHttpSession first = new MockHttpSession();
        MockHttpSession second = new MockHttpSession();
        service.connect(first, ProviderId.NETEASE_MUSIC, "real", Map.of("pairingCode", "test"));
        service.connect(second, ProviderId.NETEASE_MUSIC, "real", Map.of("pairingCode", "test"));

        service.disconnect(first, ProviderId.NETEASE_MUSIC);
        verify(access).revoke("first");
        assertThat(service.get(second, ProviderId.NETEASE_MUSIC)).isNotNull();
        second.invalidate();
        verify(access).revoke("second");
    }
}
