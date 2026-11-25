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
import com.tunebridge.web.dto.JobView;
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
    private final MigrationHistory history;
    private final ConcurrentHashMap<String, MigrationJob> jobs = new ConcurrentHashMap<>();

    public MigrationService(ProviderRegistry providerRegistry, ConnectionService connectionService,
                            TrackMatcher trackMatcher, TuneBridgeProperties properties,
                            ExecutorService executor, MigrationHistory history) {
        this.providerRegistry = providerRegistry;
        this.connectionService = connectionService;
        this.trackMatcher = trackMatcher;
        this.properties = properties;
        this.executor = executor;
        this.history = history;
    }

    public MigrationJob createJob(HttpSession session, String ownerId, ProviderId sourceProvider, String sourceUrl,
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
        MusicProvider source = providerRegistry.get(sourceProvider);
        String url = sourceUrl.trim();
        return submitJob(session, ownerId, sourceProvider, targetProvider, url,
                sanitizeName(playlistName), null, targetConnection,
                () -> source.fetchPlaylist(sourceConnection, url));
    }

    public MigrationJob createBackupJob(HttpSession session, String ownerId, ProviderId targetProvider,
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
        return submitJob(session, ownerId, targetProvider, targetProvider, "backup://local",
                sanitizeName(playlistName), "本地备份", targetConnection, () -> source);
    }

    private MigrationJob submitJob(HttpSession session, String ownerId, ProviderId sourceProvider,
                                   ProviderId targetProvider, String sourceUrl, String requestedName,
                                   String sourceLabel, ProviderConnection targetConnection,
                                   Supplier<Playlist> sourceLoader) {
        synchronized (jobs) {
            if (jobs.values().stream().anyMatch(job -> job.ownerId().equals(ownerId) && !job.terminal())) {
                throw new ProviderException(HttpStatus.CONFLICT, "ACTIVE_JOB",
                        "已有未结束的任务，请在当前任务中完成确认或暂不迁移；其他会话的任务须回原会话处理");
            }
            if (jobs.values().stream().filter(job -> !job.terminal()).count() >= 16) {
                throw ProviderException.rateLimited("当前任务较多，请稍后再试");
            }
            String jobId = "mig_" + UUID.randomUUID().toString().replace("-", "");
            MigrationJob job = sourceLabel == null
                    ? new MigrationJob(jobId, session.getId(), ownerId, sourceProvider, targetProvider,
                            sourceUrl, requestedName, targetConnection, history::save)
                    : new MigrationJob(jobId, session.getId(), ownerId, sourceProvider, targetProvider,
                            sourceUrl, requestedName, sourceLabel, targetConnection, history::save);
            job.checkpoint();
            jobs.put(jobId, job);
            try {
                executor.submit(() -> match(job, sourceLoader, targetConnection));
            } catch (java.util.concurrent.RejectedExecutionException ex) {
                job.interrupt("服务正在停止");
                throw ProviderException.notConfigured("服务正在停止，请稍后再试");
            }
            return job;
        }
    }

    public JobView getJobView(HttpSession session, String ownerId, String jobId) {
        cleanup();
        MigrationJob job = jobs.get(jobId);
        if (job != null && job.ownerId().equals(ownerId)) {
            JobView view = JobView.from(job);
            return job.sessionId().equals(session.getId()) ? view : view.asReadOnly();
        }
        return history.find(ownerId, jobId);
    }

    public MigrationHistory.Page listHistory(String ownerId, int offset, int limit,
                                             MigrationHistory.Filters filters) {
        cleanup();
        return history.list(ownerId, offset, limit, filters);
    }

    public JobView currentJob(HttpSession session, String ownerId) {
        cleanup();
        return jobs.values().stream().filter(job -> job.ownerId().equals(ownerId)
                        && job.sessionId().equals(session.getId()) && !job.terminal())
                .findFirst().map(JobView::from).orElse(null);
    }

    private MigrationJob requireSessionJob(HttpSession session, String ownerId, String jobId) {
        cleanup();
        MigrationJob job = jobs.get(jobId);
        if (job == null || !job.ownerId().equals(ownerId)) {
            history.find(ownerId, jobId);
            throw new ProviderException(HttpStatus.CONFLICT, "HISTORY_READ_ONLY", "历史任务只读，不会重新执行写入");
        }
        if (!job.sessionId().equals(session.getId())) {
            throw new ProviderException(HttpStatus.CONFLICT, "HISTORY_READ_ONLY", "只能在创建任务的原会话中确认");
        }
        return job;
    }

    public MigrationJob confirmJob(HttpSession session, String ownerId, String jobId, List<Integer> selectedIndices) {
        synchronized (session) {
            MigrationJob job = requireSessionJob(session, ownerId, jobId);
            if (job.status() != JobStatus.AWAITING_CONFIRMATION) {
                throw new ProviderException(HttpStatus.CONFLICT, "MIGRATION_STATE", "任务不在等待确认状态，请勿重复确认");
            }
            requireOriginalTarget(session, job);
            List<Track> selected = job.confirm(selectedIndices);
            try {
                executor.submit(() -> write(session, job, selected));
            } catch (java.util.concurrent.RejectedExecutionException ex) {
                job.interrupt("服务正在停止，尚未开始写入");
            }
            return job;
        }
    }

    public JobView abandonJob(HttpSession session, String ownerId, String jobId) {
        synchronized (session) {
            MigrationJob job = requireSessionJob(session, ownerId, jobId);
            if (job.status() != JobStatus.AWAITING_CONFIRMATION) {
                throw new ProviderException(HttpStatus.CONFLICT, "MIGRATION_STATE", "只能放弃尚未确认的预览");
            }
            job.interrupt("已放弃本次匹配预览");
            return JobView.from(job);
        }
    }

    public void endSession(String sessionId) {
        jobs.values().stream().filter(job -> job.sessionId().equals(sessionId) && !job.terminal()).forEach(job -> {
            try {
                job.interrupt("登录会话已结束");
            } catch (RuntimeException ex) {
                log.error("Unable to persist ended session job {}", job.id());
            }
        });
    }

    private void requireOriginalTarget(HttpSession session, MigrationJob job) {
        if (connectionService.get(session, job.targetProvider()) != job.targetConnection()) {
            throw new ProviderException(HttpStatus.CONFLICT, "TARGET_CHANGED",
                    "目标连接已断开或更换，请重新匹配后确认");
        }
    }

    private void match(MigrationJob job, Supplier<Playlist> sourceLoader, ProviderConnection targetConnection) {
        MusicProvider targetProvider = providerRegistry.get(job.targetProvider());

        try {
            job.start();
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
            int total = sourceTracks.size();
            boolean realUpstream = isReal(targetConnection);

            for (int i = 0; i < total; i++) {
                Track sourceTrack = sourceTracks.get(i);
                List<Track> candidates = targetProvider.searchTracks(targetConnection,
                        sourceTrack.title(), sourceTrack.artist(), 6);

                TrackMatcher.Evaluation evaluation = trackMatcher.evaluate(sourceTrack, candidates);
                if (evaluation.matched()) {
                    job.addMatch(TrackMatch.matched(sourceTrack, evaluation.candidate(),
                            evaluation.score(), evaluation.lowConfidence(), evaluation.note()), evaluation.candidate());
                    job.log("✓ " + sourceTrack.title() + " → " + evaluation.candidate().title()
                                    + "（" + percent(evaluation.score()) + "%）"
                                    + (evaluation.lowConfidence() ? " · 低置信" : ""),
                            "SUCCESS");
                } else {
                    job.addMatch(new TrackMatch(sourceTrack, false, false,
                            "", "", "", "", "", evaluation.score(), evaluation.note()), null);
                    job.log("✗ " + sourceTrack.title() + " · " + evaluation.note(), "WARN");
                }

                job.step("正在匹配 " + (i + 1) + " / " + total, 15 + (int) (60.0 * (i + 1) / total));
                sleep(realUpstream ? Math.max(0, properties.getMigration().getRequestIntervalMs()) : 80);
            }

            if (job.matchesSnapshot().stream().noneMatch(TrackMatch::matched)) {
                throw ProviderException.upstream("没有匹配到任何歌曲，已取消创建空歌单");
            }

            job.awaitConfirmation();
        } catch (ProviderException ex) {
            job.fail(ex.getMessage());
        } catch (Exception ex) {
            log.error("Matching {} failed", job.id(), ex);
            job.fail("匹配失败，请稍后重新匹配");
        }
    }

    private void write(HttpSession session, MigrationJob job, List<Track> selected) {
        MusicProvider targetProvider = providerRegistry.get(job.targetProvider());
        ProviderConnection targetConnection = job.targetConnection();
        Playlist source = job.sourcePlaylist();
        CreatedPlaylist created = null;
        try {
            job.step("正在创建目标歌单", 79);
            String targetName = job.requestedName().isBlank()
                    ? sanitizeName(source.name() + " · 音桥")
                    : job.requestedName();
            if (targetName.isBlank()) {
                targetName = "音桥迁移歌单";
            }
            String description = "由 TuneBridge 从「" + source.name() + "」迁移，已确认 "
                    + selected.size() + " / " + job.matchesSnapshot().size() + " 首";

            synchronized (session) {
                requireOriginalTarget(session, job);
                job.beginWrite();
                created = targetProvider.createPlaylist(targetConnection, targetName, description);
                job.targetCreated(created);
            }
            job.progress(84);
            job.log("已在 " + job.targetProvider().label() + " 创建歌单《" + created.name() + "》", "SUCCESS");

            job.step("正在写入歌曲", 88);
            synchronized (session) {
                requireOriginalTarget(session, job);
                targetProvider.addTracks(targetConnection, created, selected);
                job.complete(new CreatedPlaylist(created.id(), created.name(), created.url(),
                        selected.size(), java.util.Map.of()));
            }
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
            job.fail("迁移失败，请检查目标歌单后手动处理，勿自动重试");
        }
    }

    private boolean isReal(ProviderConnection connection) {
        return connection != null && connection.mode() == com.tunebridge.domain.ConnectionMode.REAL;
    }

    private void cleanup() {
        Instant cutoff = Instant.now().minus(Duration.ofHours(2));
        jobs.entrySet().removeIf(entry -> {
            MigrationJob job = entry.getValue();
            if (job.status() == JobStatus.AWAITING_CONFIRMATION && job.createdAt().isBefore(cutoff)) {
                job.interrupt("匹配预览已过期");
            }
            return job.terminal() && job.createdAt().isBefore(cutoff);
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
