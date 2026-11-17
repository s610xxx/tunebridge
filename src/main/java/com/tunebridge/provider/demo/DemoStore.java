package com.tunebridge.provider.demo;

import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;

@Component
public class DemoStore {

    private final Map<String, Map<ProviderId, List<Playlist>>> sessions = new ConcurrentHashMap<>();
    private final AtomicInteger sequence = new AtomicInteger(1000);
    private final Object lock = new Object();

    public Playlist create(String sessionId, ProviderId provider, String name, String description) {
        String id = "demo-" + sequence.incrementAndGet();
        Playlist playlist = new Playlist(id, name, description, "", "演示音乐库", "demo://library/" + id, List.of());
        synchronized (lock) {
            playlists(sessionId, provider).add(playlist);
        }
        return playlist;
    }

    public void addTracks(String sessionId, ProviderId provider, String playlistId, List<Track> tracks) {
        synchronized (lock) {
            List<Playlist> playlists = playlists(sessionId, provider);
            for (int i = 0; i < playlists.size(); i++) {
                Playlist current = playlists.get(i);
                if (current.id().equals(playlistId)) {
                    List<Track> merged = new ArrayList<>(current.tracks());
                    merged.addAll(tracks);
                    playlists.set(i, new Playlist(current.id(), current.name(), current.description(),
                            current.coverUrl(), current.owner(), current.webUrl(), merged));
                    return;
                }
            }
        }
        throw new IllegalArgumentException("演示歌单不存在");
    }

    public Playlist find(String sessionId, ProviderId provider, String playlistId) {
        synchronized (lock) {
            return playlists(sessionId, provider).stream()
                    .filter(p -> p.id().equals(playlistId))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("演示歌单不存在或已过期"));
        }
    }

    public List<Playlist> list(String sessionId, ProviderId provider) {
        synchronized (lock) {
            return List.copyOf(playlists(sessionId, provider));
        }
    }

    private List<Playlist> playlists(String sessionId, ProviderId provider) {
        return sessions
                .computeIfAbsent(sessionId, ignored -> new ConcurrentHashMap<>())
                .computeIfAbsent(provider, ignored -> new ArrayList<>());
    }
}
