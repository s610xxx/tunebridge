package com.tunebridge.provider.demo;

import static org.assertj.core.api.Assertions.assertThat;

import com.tunebridge.domain.PlaylistRef;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import java.util.List;
import org.junit.jupiter.api.Test;

class DemoPlaylistsTest {

    @Test
    void offersTheBuiltinPlaylistBeforeWhateverTheSessionCreated() {
        DemoCatalog catalog = new DemoCatalog();
        DemoStore store = new DemoStore();

        assertThat(DemoPlaylists.of(catalog, store, ProviderId.QQ_MUSIC, "s-1")).singleElement()
                .extracting(PlaylistRef::url).isEqualTo("demo://builtin");

        var created = store.create("s-1", ProviderId.QQ_MUSIC, "夏日备选", "");
        store.addTracks("s-1", ProviderId.QQ_MUSIC, created.id(),
                List.of(new Track("d1", "晴天", "周杰伦", "叶惠美", 269, "", 0),
                        new Track("d2", "小半", "陈粒", "小梦大半", 297, "", 0)));

        List<PlaylistRef> refs = DemoPlaylists.of(catalog, store, ProviderId.QQ_MUSIC, "s-1");

        assertThat(refs).hasSize(2);
        assertThat(refs.get(0).name()).isEqualTo("夏夜循环 · 华语流行");
        assertThat(refs.get(0).trackCount()).isEqualTo(12);
        assertThat(refs.get(1).id()).isEqualTo(created.id());
        assertThat(refs.get(1).url()).isEqualTo("demo://library/" + created.id());
        assertThat(refs.get(1).trackCount()).isEqualTo(2);
    }

    @Test
    void keepsDemoLibrariesApartPerSessionAndProvider() {
        DemoCatalog catalog = new DemoCatalog();
        DemoStore store = new DemoStore();
        store.create("s-1", ProviderId.QQ_MUSIC, "只属于 s1", "");
        store.create("s-2", ProviderId.APPLE_MUSIC, "只属于 s2", "");

        assertThat(DemoPlaylists.of(catalog, store, ProviderId.QQ_MUSIC, "s-1"))
                .extracting(PlaylistRef::name).containsExactly("夏夜循环 · 华语流行", "只属于 s1");
        assertThat(DemoPlaylists.of(catalog, store, ProviderId.APPLE_MUSIC, "s-2"))
                .extracting(PlaylistRef::name).containsExactly("Indie 深夜电台", "只属于 s2");
    }
}
