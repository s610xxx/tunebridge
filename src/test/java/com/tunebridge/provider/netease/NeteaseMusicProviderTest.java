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
                mock(NeteaseWebClient.class), mock(NeteaseLocalAccess.class), catalog, store);
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
    void cookieFromQrLoginDrivesEveryWriteThroughTheWebClient() {
        String cookie = "MUSIC_U=token";
        NeteaseWebClient webClient = mock(NeteaseWebClient.class);
        NeteaseLocalAccess access = mock(NeteaseLocalAccess.class);
        NeteaseMusicClient client = mock(NeteaseMusicClient.class);
        when(webClient.accountName(cookie)).thenReturn("小明");
        when(webClient.searchTracks(eq(cookie), anyString(), anyString(), anyInt())).thenReturn(List.of());
        CreatedPlaylist created = CreatedPlaylist.of("p1", "我的歌单", "", 0);
        when(webClient.createPlaylist(cookie, "我的歌单")).thenReturn(created);
        NeteaseMusicProvider provider = new NeteaseMusicProvider(client, webClient, access,
                new DemoCatalog(), new DemoStore());

        ProviderConnection connection = provider.connectReal(Map.of("cookie", cookie));
        provider.searchTracks(connection, "晴天", "周杰伦", 5);
        assertEquals(created, provider.createPlaylist(connection, "我的歌单", "描述"));
        provider.addTracks(connection, created, List.of(new Track("1", "t", "a", "al", 1, "", 0)));

        assertEquals(Map.of("neteaseCookie", cookie), connection.credentials());
        assertTrue(connection.accountName().contains("小明"));
        verify(webClient).addTracks(eq(cookie), eq(created), any());
        verifyNoInteractions(access, client);
    }

    @Test
    void blankCookieFallsBackToTheLocalPairingCode() {
        NeteaseWebClient webClient = mock(NeteaseWebClient.class);
        NeteaseLocalAccess access = mock(NeteaseLocalAccess.class);
        when(access.authorize("pair")).thenReturn("grant");
        NeteaseMusicProvider provider = new NeteaseMusicProvider(mock(NeteaseMusicClient.class), webClient,
                access, new DemoCatalog(), new DemoStore());

        ProviderConnection connection = provider.connectReal(Map.of("cookie", "  ", "pairingCode", "pair"));

        assertEquals(Map.of("neteaseGrant", "grant"), connection.credentials());
        verifyNoInteractions(webClient);
    }

    @Test
    void grantsGuardAllOperationsAndValidationFailureRevokes() {
        NeteaseMusicClient client = mock(NeteaseMusicClient.class);
        NeteaseLocalAccess access = mock(NeteaseLocalAccess.class);
        when(access.authorize("pair")).thenReturn("grant");
        when(access.withGrant(eq("grant"), any())).thenAnswer(invocation ->
                ((Supplier<?>) invocation.getArgument(1)).get());
        NeteaseMusicProvider provider = new NeteaseMusicProvider(client, mock(NeteaseWebClient.class),
                access, new DemoCatalog(), new DemoStore());
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
