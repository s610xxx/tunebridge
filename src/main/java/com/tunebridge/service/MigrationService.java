package com.tunebridge.service;

import com.tunebridge.config.TuneBridgeProperties;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.JobStatus;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.domain.TrackMatch;
import com.tunebridge.provider.MusicProvider;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.provider.ProviderRegistry;
import jakarta.servlet.http.HttpSession;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class MigrationService {

    private static final Logger log = LoggerFactory.getLogger(MigrationService.class);

    private final ProviderRegistry providerRegistry;
    private final ConnectionService connectionService;
    private final TrackMatcher trackMatcher;
    private final TuneBridgeProperties properties;
    private final ExecutorService executor;
    private final ConcurrentHashMap<String, MigrationJob> jobs = new ConcurrentHashMap<>();

    public MigrationService(ProviderRegistry providerRegistry, ConnectionService connectionService,
                            TrackMatcher trackMatcher, TuneBridgeProperties properties,
                            ExecutorService executor) {
        this.providerRegistry = providerRegistry;
        this.connectionService = connectionService;
        this.trackMatcher = trackMatcher;
        this.properties = properties;
        this.executor = executor;
    }

    public MigrationJob createJob(HttpSession session, ProviderId sourceProvider, String sourceUrl,
                                  ProviderId targetProvider, String playlistName) {
        if (sourceProvider == targetProvider) {
            throw ProviderException.badRequest("来源平台和目标平台不能相同");
        }
        if (sourceProvider == ProviderId.NETEASE_MUSIC
                || (targetProvider == ProviderId.NETEASE_MUSIC && sourceProvider != ProviderId.QQ_MUSIC)) {
            throw ProviderException.badRequest("网易云音乐目前只支持作为 QQ 音乐迁移的目标平台");
        }
        if (sourceUrl == null || sourceUrl.isBlank()) {
            throw ProviderException.badRequest("请粘贴来源歌单链接");
        }

        ProviderConnection targetConnection = connectionService.require(session, targetProvider);
        ProviderConnection sourceConnection = connectionService.get(session, sourceProvider);
        if (sourceProvider == ProviderId.APPLE_MUSIC && sourceConnection == null) {
            throw ProviderException.notConnected("请先连接 Apple Music（来源平台）");
        }
        if (sourceUrl.startsWith("demo://") && sourceConnection == null) {
            throw ProviderException.notConnected("请先连接" + sourceProvider.label() + "演示账号");
        }

        cleanup();

        String jobId = "mig_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String safeName = sanitizeName(playlistName);
        MigrationJob job = new MigrationJob(jobId, session.getId(), sourceProvider, targetProvider,
                sourceUrl.trim(), safeName);
        jobs.put(jobId, job);
        MusicProvider source = providerRegistry.get(sourceProvider);
        executor.submit(() -> run(job,
                () -> source.fetchPlaylist(sourceConnection, job.sourceUrl()), targetConnection));
        return job;
    }

    public MigrationJob createBackupJob(HttpSession session, ProviderId targetProvider,
                                        String playlistName, String sourceName, List<Track> tracks) {
        ProviderConnection targetConnection = connectionService.require(session, targetProvider);
        int inputLimit = Math.max(1, properties.getMigration().getMaxTracks()) * 5;
        if (tracks == null || tracks.isEmpty()) {
            throw ProviderException.badRequest("备份中没有可迁移的曲目");
        }
        if (tracks.size() > inputLimit) {
            throw ProviderException.badRequest("备份曲目过多，单次最多处理 " + inputLimit + " 首");
        }

        List<Track> sourceTracks = new ArrayList<>();
        for (Track track : tracks) {
            if (track == null) {
                continue;
            }
            String title = clean(track.title(), 300);
            if (title.isBlank()) {
                continue;
            }
            int duration = Math.max(0, Math.min(track.durationSec(), 24 * 3600));
            sourceTracks.add(new Track("", title, clean(track.artist(), 300),
                    clean(track.album(), 300), duration, "", 0));
        }
        if (sourceTracks.isEmpty()) {
            throw ProviderException.badRequest("备份中没有可迁移的曲目");
        }

        String name = sanitizeName(sourceName);
        if (name.isBlank()) {
            name = "本地备份";
        }
        Playlist source = new Playlist("backup", name, "来自本地备份", "", "本地备份", "", sourceTracks);

        cleanup();
        String jobId = "mig_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        MigrationJob job = new MigrationJob(jobId, session.getId(), targetProvider, targetProvider,
                "backup://local", sanitizeName(playlistName), "本地备份");
        jobs.put(jobId, job);
        executor.submit(() -> run(job, () -> source, targetConnection));
        return job;
    }

    public MigrationJob getJob(HttpSession session, String jobId) {
        MigrationJob job = jobs.get(jobId);
        if (job == null || !job.sessionId().equals(session.getId())) {
            throw ProviderException.notFound("迁移任务不存在或已过期");
        }
        return job;
    }

    private void run(MigrationJob job, Supplier<Playlist> sourceLoader, ProviderConnection targetConnection) {
        job.start();
        MusicProvider targetProvider = providerRegistry.get(job.targetProvider());
        CreatedPlaylist created = null;

        try {
            job.step("正在读取来源歌单", 5);
            Playlist source = sourceLoader.get();
            if (source.tracks().isEmpty()) {
                throw ProviderException.badRequest("来源歌单没有可迁移的歌曲");
            }
            job.sourceLoaded(source);

            int maxTracks = Math.max(1, properties.getMigration().getMaxTracks());
            List<Track> sourceTracks = source.tracks();
            if (sourceTracks.size() > maxTracks) {
                sourceTracks = sourceTracks.subList(0, maxTracks);
                job.log("来源共 " + source.tracks().size() + " 首，本次按上限迁移前 " + maxTracks + " 首", "WARN");
            }

            job.step("正在匹配歌曲", 15);
            List<Track> matchedTargets = new ArrayList<>();
            int total = sourceTracks.size();
            int searchFailures = 0;
            ProviderException lastSearchError = null;
            boolean realUpstream = isReal(targetConnection);

            for (int i = 0; i < total; i++) {
                Track sourceTrack = sourceTracks.get(i);
                List<Track> candidates;
                try {
                    candidates = targetProvider.searchTracks(targetConnection,
                            sourceTrack.title(), sourceTrack.artist(), 6);
                } catch (ProviderException ex) {
                    if (ex.status() == HttpStatus.UNAUTHORIZED
                            || ex.status() == HttpStatus.SERVICE_UNAVAILABLE
                            || ex.status() == HttpStatus.TOO_MANY_REQUESTS) {
                        throw ex;
                    }
                    searchFailures++;
                    lastSearchError = ex;
                    job.log("搜索《" + sourceTrack.title() + "》失败：" + ex.getMessage(), "WARN");
                    candidates = List.of();
                }

                TrackMatcher.Evaluation evaluation = trackMatcher.evaluate(sourceTrack, candidates);
                if (evaluation.matched()) {
                    matchedTargets.add(evaluation.candidate());
                    job.addMatch(TrackMatch.matched(sourceTrack, evaluation.candidate(),
                            evaluation.score(), evaluation.lowConfidence(), evaluation.note()));
                    job.log("✓ " + sourceTrack.title() + " → " + evaluation.candidate().title()
                                    + "（" + percent(evaluation.score()) + "%）"
                                    + (evaluation.lowConfidence() ? " · 低置信" : ""),
                            "SUCCESS");
                } else {
                    job.addMatch(new TrackMatch(sourceTrack, false, false,
                            "", "", "", "", "", evaluation.score(), evaluation.note()));
                    job.log("✗ " + sourceTrack.title() + " · " + evaluation.note(), "WARN");
                }

                job.step("正在匹配 " + (i + 1) + " / " + total, 15 + (int) (60.0 * (i + 1) / total));
                sleep(realUpstream ? Math.max(0, properties.getMigration().getRequestIntervalMs()) : 80);
            }

            if (matchedTargets.isEmpty()) {
                if (searchFailures == total && lastSearchError != null) {
                    throw lastSearchError;
                }
                throw ProviderException.upstream("没有匹配到任何歌曲，已取消创建空歌单");
            }

            job.step("正在创建目标歌单", 79);
            String targetName = job.requestedName().isBlank()
                    ? sanitizeName(source.name() + " · 音桥")
                    : job.requestedName();
            if (targetName.isBlank()) {
                targetName = "音桥迁移歌单";
            }
            String description = "由 TuneBridge 从「" + source.name() + "」迁移，匹配 "
                    + matchedTargets.size() + " / " + total + " 首";

            created = targetProvider.createPlaylist(targetConnection, targetName, description);
            job.progress(84);
            job.log("已在 " + job.targetProvider().label() + " 创建歌单《" + created.name() + "》", "SUCCESS");

            job.step("正在写入歌曲", 88);
            targetProvider.addTracks(targetConnection, created, matchedTargets);
            job.progress(98);
            job.complete(new CreatedPlaylist(created.id(), created.name(), created.url(),
                    matchedTargets.size(), created.metadata()));
        } catch (ProviderException ex) {
            if (created != null) {
                job.log("目标歌单已创建，但歌曲写入未完成，请在目标平台检查后手动处理", "WARN");
            }
            job.fail(ex.getMessage());
        } catch (Exception ex) {
            log.error("Migration {} failed", job.id(), ex);
            if (created != null) {
                job.log("目标歌单已创建，但歌曲写入未完成，请在目标平台检查后手动处理", "WARN");
            }
            job.fail("迁移失败，请稍后重试");
        }
    }

    private boolean isReal(ProviderConnection connection) {
        return connection != null && connection.mode() == com.tunebridge.domain.ConnectionMode.REAL;
    }

    private void cleanup() {
        Instant cutoff = Instant.now().minus(Duration.ofHours(2));
        jobs.entrySet().removeIf(entry -> {
            MigrationJob job = entry.getValue();
            return (job.status() == JobStatus.COMPLETED || job.status() == JobStatus.FAILED)
                    && job.createdAt().isBefore(cutoff);
        });
    }

    private static String clean(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        String cleaned = value.replaceAll("[\\p{Cntrl}]", "").replaceAll("\\s+", " ").trim();
        int count = cleaned.codePointCount(0, cleaned.length());
        if (count <= maxLength) {
            return cleaned;
        }
        return cleaned.substring(0, cleaned.offsetByCodePoints(0, maxLength)).trim();
    }

    private static String sanitizeName(String name) {
        if (name == null) {
            return "";
        }
        String cleaned = name.replaceAll("[\\p{Cntrl}]", "").replaceAll("\\s+", " ").trim();
        if (cleaned.length() > 60) {
            cleaned = cleaned.substring(0, 60).trim();
        }
        return cleaned;
    }

    private static int percent(double score) {
        return (int) Math.round(score * 100);
    }

    private static void sleep(long millis) {
        if (millis <= 0) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }
}
