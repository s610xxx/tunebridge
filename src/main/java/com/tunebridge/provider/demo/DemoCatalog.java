package com.tunebridge.provider.demo;

import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class DemoCatalog {

    private final Map<ProviderId, Playlist> builtinPlaylists = new EnumMap<>(ProviderId.class);
    private final Map<ProviderId, List<Track>> targetCatalogs = new EnumMap<>(ProviderId.class);

    public DemoCatalog() {
        List<Track> qqSourceTracks = List.of(
                Track.of("dq-1", "晴天", "周杰伦", "叶惠美", 269),
                Track.of("dq-2", "小半", "陈粒", "小梦大半", 297),
                Track.of("dq-3", "平凡之路", "朴树", "猎户星座", 302),
                Track.of("dq-4", "夜空中最亮的星", "逃跑计划", "世界", 252),
                Track.of("dq-5", "起风了", "买辣椒也用券", "起风了", 325),
                Track.of("dq-6", "漠河舞厅", "柳爽", "漠河舞厅", 333),
                Track.of("dq-7", "孤勇者", "陈奕迅", "孤勇者", 257),
                Track.of("dq-8", "稻香", "周杰伦", "魔杰座", 223),
                Track.of("dq-9", "海底", "一支榴莲", "海底", 276),
                Track.of("dq-10", "像风一样", "薛之谦", "渡", 247),
                Track.of("dq-11", "若把你", "KIV", "若把你", 214),
                Track.of("dq-12", "晚风心里吹", "阿梨粤", "晚风心里吹", 231)
        );

        List<Track> appleSourceTracks = List.of(
                Track.of("da-1", "Snow on the Beach", "Taylor Swift", "Midnights", 256),
                Track.of("da-2", "As It Was", "Harry Styles", "Harry's House", 167),
                Track.of("da-3", "凄美地", "郭顶", "飞行器的执行周期", 250),
                Track.of("da-4", "Sunset Lover", "Petit Biscuit", "Presence", 238),
                Track.of("da-5", "关于我爱你", "张悬", "城市", 305),
                Track.of("da-6", "I Love You So", "The Walters", "Songs for Dads", 160),
                Track.of("da-7", "水星记", "郭顶", "飞行器的执行周期", 325),
                Track.of("da-8", "Lover", "Taylor Swift", "Lover", 221),
                Track.of("da-9", "Golden Hour", "JVKE", "this is what ____ feels like", 209),
                Track.of("da-10", "浪漫手机", "周杰伦", "十一月的萧邦", 243)
        );

        builtinPlaylists.put(ProviderId.QQ_MUSIC,
                new Playlist("demo-qq-builtin", "夏夜循环 · 华语流行", "QQ 音乐演示歌单",
                        "", "演示账号 · 阿桥", "demo://builtin", qqSourceTracks));

        builtinPlaylists.put(ProviderId.APPLE_MUSIC,
                new Playlist("demo-apple-builtin", "Indie 深夜电台", "Apple Music 演示歌单",
                        "", "演示账号 · Bridge", "demo://builtin", appleSourceTracks));

        targetCatalogs.put(ProviderId.APPLE_MUSIC, List.of(
                new Track("1440857781", "晴天 (Live)", "周杰伦", "地表最强世界巡回演唱会", 271, "", 0),
                new Track("1440857792", "小半", "陈粒", "小梦大半", 297, "", 0),
                new Track("1440857803", "平凡之路", "朴树", "猎户星座", 302, "", 0),
                new Track("1440857814", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0),
                new Track("1440857825", "起风了", "买辣椒也用券", "起风了", 325, "", 0),
                new Track("1440857836", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0),
                new Track("1440857847", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0),
                new Track("1440857858", "稻香", "周杰伦", "魔杰座", 223, "", 0),
                new Track("1440857869", "海底", "一支榴莲", "海底", 276, "", 0),
                new Track("1440857870", "像风一样", "薛之谦", "渡", 247, "", 0),
                new Track("1440857881", "七里香", "周杰伦", "七里香", 299, "", 0),
                new Track("1440857892", "反方向的钟", "周杰伦", "Jay", 258, "", 0)
        ));

        targetCatalogs.put(ProviderId.QQ_MUSIC, List.of(
                new Track("97773", "Snow on the Beach", "Taylor Swift", "Midnights", 256, "", 0),
                new Track("102065756", "As It Was", "Harry Styles", "Harry's House", 167, "", 0),
                new Track("107762070", "凄美地", "郭顶", "飞行器的执行周期", 250, "", 0),
                new Track("718475", "关于我爱你", "张悬", "城市", 305, "", 0),
                new Track("5177680", "I Love You So", "The Walters", "Songs for Dads", 160, "", 0),
                new Track("279917003", "水星记", "郭顶", "飞行器的执行周期", 325, "", 0),
                new Track("279917248", "Lover", "Taylor Swift", "Lover", 221, "", 0),
                new Track("501052971", "浪漫手机", "周杰伦", "十一月的萧邦", 243, "", 0),
                new Track("482567808", "七里香", "周杰伦", "七里香", 299, "", 0),
                new Track("279917247", "晴天", "周杰伦", "叶惠美", 269, "", 0),
                new Track("279917301", "小半", "陈粒", "小梦大半", 297, "", 0),
                new Track("279917302", "平凡之路", "朴树", "猎户星座", 302, "", 0),
                new Track("279917303", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0),
                new Track("279917304", "起风了", "买辣椒也用券", "起风了", 325, "", 0),
                new Track("279917305", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0),
                new Track("279917306", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0),
                new Track("279917307", "稻香", "周杰伦", "魔杰座", 223, "", 0),
                new Track("279917308", "海底", "一支榴莲", "海底", 276, "", 0),
                new Track("279917309", "像风一样", "薛之谦", "渡", 247, "", 0),
                new Track("279917310", "若把你", "KIV", "若把你", 214, "", 0),
                new Track("279917311", "晚风心里吹", "阿梨粤", "晚风心里吹", 231, "", 0)
        ));
        targetCatalogs.put(ProviderId.NETEASE_MUSIC, targetCatalogs.get(ProviderId.QQ_MUSIC));
    }

    public Playlist builtin(ProviderId provider) {
        Playlist playlist = builtinPlaylists.get(provider);
        if (playlist == null) {
            throw new IllegalArgumentException("没有可用的演示歌单");
        }
        return playlist;
    }

    public List<Track> targetCatalog(ProviderId provider) {
        return targetCatalogs.getOrDefault(provider, List.of());
    }
}
