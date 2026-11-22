package com.tunebridge.provider;

import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.PlaylistRef;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import java.util.List;
import java.util.Map;

public interface MusicProvider {

    ProviderId id();

    String sampleUrl();

    ProviderConnection connectDemo(String sessionId);

    ProviderConnection connectReal(Map<String, String> credentials);

    Playlist fetchPlaylist(ProviderConnection connection, String url);

    /**
     * Playlists the connected account owns, so the caller can queue several migrations at once.
     * Throws when the account is not connected or the platform cannot act as a batch source.
     */
    List<PlaylistRef> listPlaylists(ProviderConnection connection);

    List<Track> searchTracks(ProviderConnection connection, String title, String artist, int limit);

    CreatedPlaylist createPlaylist(ProviderConnection connection, String name, String description);

    void addTracks(ProviderConnection connection, CreatedPlaylist playlist, List<Track> tracks);
}
