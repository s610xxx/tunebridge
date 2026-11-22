package com.tunebridge.provider.demo;

import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.PlaylistRef;
import com.tunebridge.domain.ProviderId;
import java.util.ArrayList;
import java.util.List;

/**
 * The demo account's selectable sources: the built-in playlist plus whatever the session has already
 * created. Batch migration reads these refs and then fetches each one through the normal source path.
 */
public final class DemoPlaylists {

    private DemoPlaylists() {
    }

    public static List<PlaylistRef> of(DemoCatalog catalog, DemoStore store, ProviderId provider, String sessionId) {
        List<PlaylistRef> refs = new ArrayList<>();
        Playlist builtin = catalog.builtin(provider);
        refs.add(new PlaylistRef(builtin.id(), builtin.name(), builtin.webUrl(), builtin.coverUrl(),
                builtin.tracks().size()));
        for (Playlist created : store.list(sessionId, provider)) {
            refs.add(new PlaylistRef(created.id(), created.name(), created.webUrl(), created.coverUrl(),
                    created.tracks().size()));
        }
        return List.copyOf(refs);
    }
}
