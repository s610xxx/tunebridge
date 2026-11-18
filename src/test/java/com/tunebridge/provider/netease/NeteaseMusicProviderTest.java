package com.tunebridge.provider.netease;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.demo.DemoCatalog;
import com.tunebridge.provider.demo.DemoStore;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

class NeteaseMusicProviderTest {
    @Test
    void demoUsesCatalogAndStoresPlaylist() {
        DemoCatalog catalog = new DemoCatalog();
        DemoStore store = new DemoStore();
        NeteaseMusicProvider provider = new NeteaseMusicProvider(mock(NeteaseMusicClient.class),
                mock(NeteaseLocalAccess.class), catalog, store);
        ProviderConnection connection = provider.connectDemo("session");
        assertEquals(ProviderId.NETEASE_MUSIC, ProviderId.from("netease-music"));
        assertEquals(catalog.targetCatalog(ProviderId.QQ_MUSIC), provider.searchTracks(connection, "x", "", 5));
        CreatedPlaylist playlist = provider.createPlaylist(connection, "测试", "描述");
        Track track = catalog.targetCatalog(ProviderId.QQ_MUSIC).get(0);
        provider.addTracks(connection, playlist, List.of(track));
        assertEquals(List.of(track), store.find("session", ProviderId.NETEASE_MUSIC, playlist.id()).tracks());
        assertThrows(ProviderException.class, () -> provider.fetchPlaylist(connection, "demo://builtin"));
    }

    @Test
    void grantsGuardAllOperationsAndValidationFailureRevokes() {
        NeteaseMusicClient client = mock(NeteaseMusicClient.class);
        NeteaseLocalAccess access = mock(NeteaseLocalAccess.class);
        when(access.authorize("pair")).thenReturn("grant");
        when(access.withGrant(eq("grant"), any())).thenAnswer(invocation ->
                ((Supplier<?>) invocation.getArgument(1)).get());
        NeteaseMusicProvider provider = new NeteaseMusicProvider(client, access, new DemoCatalog(), new DemoStore());
        ProviderConnection connection = provider.connectReal(Map.of("pairingCode", "pair"));
        assertEquals(Map.of("neteaseGrant", "grant"), connection.credentials());
        provider.searchTracks(connection, "x", "a", 1);
        provider.createPlaylist(connection, "name", "desc");
        provider.addTracks(connection, CreatedPlaylist.of("p", "x", "", 0), List.of());
        verify(access, times(4)).withGrant(eq("grant"), any());
        doThrow(ProviderException.upstream("failed")).when(client).validateLogin();
        assertThrows(ProviderException.class, () -> provider.connectReal(Map.of("pairingCode", "pair")));
        verify(access).revoke("grant");
    }
}
