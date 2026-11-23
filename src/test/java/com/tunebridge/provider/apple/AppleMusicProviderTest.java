package com.tunebridge.provider.apple;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.demo.DemoCatalog;
import com.tunebridge.provider.demo.DemoStore;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AppleMusicProviderTest {

    private final AppleMusicClient client = mock(AppleMusicClient.class);
    private final AppleAccessTokenService tokens = mock(AppleAccessTokenService.class);
    private final DemoStore demoStore = new DemoStore();
    private final AppleMusicProvider provider =
            new AppleMusicProvider(client, tokens, new DemoCatalog(), demoStore, new TuneBridgeProperties());

    private ProviderConnection realConnection() {
        when(client.validate("tok")).thenReturn("cn");
        return provider.connectReal(Map.of("musicUserToken", " tok "));
    }

    @Test
    void pastedMediaUserTokenDrivesLibraryReads() {
        when(tokens.writesAllowed()).thenReturn(false);
        ProviderConnection connection = realConnection();

        assertThat(connection.credential("musicUserToken")).isEqualTo("tok");
        assertThat(connection.accountName()).contains("CN").contains("仅迁出");

        provider.listPlaylists(connection);
        verify(client).listLibraryPlaylists("tok", "cn", 50);
    }

    @Test
    void blankTokenIsRejectedBeforeTouchingApple() {
        assertThatThrownBy(() -> provider.connectReal(Map.of("musicUserToken", "   ")))
                .isInstanceOf(ProviderException.class)
                .hasMessageContaining("media-user-token");
        verifyNoInteractions(client, tokens);
    }

    @Test
    void realWritesStopWithoutTheOfficialChannel() {
        when(tokens.writesAllowed()).thenReturn(false);
        ProviderConnection connection = realConnection();
        CreatedPlaylist playlist = CreatedPlaylist.of("p1", "新歌单", "", 0);

        assertThatThrownBy(() -> provider.createPlaylist(connection, "新歌单", "描述"))
                .isInstanceOf(ProviderException.class)
                .satisfies(ex -> assertThat(((ProviderException) ex).code()).isEqualTo("NOT_CONFIGURED"));
        assertThatThrownBy(() -> provider.addTracks(connection, playlist,
                List.of(new Track("1", "t", "a", "al", 1, "", 0))))
                .isInstanceOf(ProviderException.class);

        verify(client, never()).createPlaylist(anyString(), anyString(), anyString(), anyString());
        verify(client, never()).addTracks(anyString(), any(), any());
    }

    @Test
    void officialChannelStillWrites() {
        when(tokens.writesAllowed()).thenReturn(true);
        ProviderConnection connection = realConnection();
        CreatedPlaylist playlist = CreatedPlaylist.of("p1", "新歌单", "", 0);
        when(client.createPlaylist("tok", "cn", "新歌单", "描述")).thenReturn(playlist);

        assertThat(provider.createPlaylist(connection, "新歌单", "描述")).isEqualTo(playlist);
        provider.addTracks(connection, playlist, List.of(new Track("1", "t", "a", "al", 1, "", 0)));

        verify(client).addTracks(anyString(), any(), any());
        assertThat(connection.accountName()).doesNotContain("仅迁出");
    }

    @Test
    void demoTargetIgnoresTheChannelDecision() {
        ProviderConnection connection = provider.connectDemo("session");

        CreatedPlaylist created = provider.createPlaylist(connection, "演示歌单", "描述");
        provider.addTracks(connection, created, List.of(new Track("1", "t", "a", "al", 1, "", 0)));

        verifyNoInteractions(tokens);
        assertThat(demoStore.find("session", ProviderId.APPLE_MUSIC, created.id()).tracks())
                .hasSize(1);
    }
}
