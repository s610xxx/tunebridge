package com.tunebridge.domain;

import com.tunebridge.provider.ProviderException;
import java.time.Instant;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.springframework.http.HttpStatus;

public class MigrationJob {

    private static final DateTimeFormatter TIME_FORMAT = DateTimeFormatter.ofPattern("HH:mm:ss");
    private static final int MAX_LOGS = 240;

    private final String id;
    private final String sessionId;
    private final String ownerId;
    private final ProviderId sourceProvider;
    private final ProviderId targetProvider;
    private final String sourceUrl;
    private final String requestedName;
    private final ConnectionMode targetMode;
    private final Consumer<MigrationJob> persistence;
    private volatile ProviderConnection targetConnection;
    private final Instant createdAt = Instant.now();

    private final List<LogEntry> logs = new ArrayList<>();
    private final List<TrackMatch> matches = new ArrayList<>();
    private final Map<Integer, Track> targets = new HashMap<>();
    private List<Integer> selectedIndices = List.of();

    private volatile JobStatus status = JobStatus.QUEUED;
    private volatile int progress;
    private volatile String currentStep = "等待开始";
    private volatile Playlist sourcePlaylist;
    private volatile CreatedPlaylist createdTarget;
    private volatile CreatedPlaylist result;
    private volatile String error = "";
    private volatile String recoveryNotice;
    private volatile boolean writeStarted;

    public MigrationJob(String id, String sessionId, String ownerId, ProviderId sourceProvider,
                        ProviderId targetProvider, String sourceUrl, String requestedName,
                        ProviderConnection targetConnection, Consumer<MigrationJob> persistence) {
        this.id = id;
        this.sessionId = sessionId;
        this.ownerId = ownerId;
        this.sourceProvider = sourceProvider;
        this.targetProvider = targetProvider;
        this.sourceUrl = sourceUrl;
        this.requestedName = requestedName;
        this.targetConnection = targetConnection;
        this.targetMode = targetConnection.mode();
        this.persistence = persistence;
    }

    public synchronized void checkpoint() {
        try {
            persistence.accept(this);
        } catch (RuntimeException ex) {
            status = JobStatus.INTERRUPTED;
            currentStep = "任务存储不可用，已停止后续操作";
            recoveryNotice = writeStarted
                    ? "任务记录保存失败，目标平台可能已发生写入，请手动核查，勿自动重试。"
                    : "任务记录保存失败，已停止；未开始写入目标平台。";
            error = recoveryNotice;
            releaseConnection();
            throw ex;
        }
    }

    public synchronized void start() {
        requireActive();
        status = JobStatus.RUNNING;
        progress = 2;
        currentStep = "准备匹配";
        log("匹配任务已创建，确认前不会创建或写入目标歌单", "INFO");
        checkpoint();
    }

    public synchronized void step(String text, int newProgress) {
        requireActive();
        currentStep = text;
        progress = Math.max(progress, Math.min(99, newProgress));
        checkpoint();
    }

    public synchronized void progress(int newProgress) {
        requireActive();
        progress = Math.max(progress, Math.min(100, newProgress));
        checkpoint();
    }

    public synchronized void log(String message, String level) {
        logs.add(new LogEntry(LocalTime.now().format(TIME_FORMAT), message, level));
        if (logs.size() > MAX_LOGS) logs.remove(0);
    }

    public synchronized void sourceLoaded(Playlist playlist) {
        requireActive();
        sourcePlaylist = playlist;
        log("已读取《" + playlist.name() + "》，共 " + playlist.tracks().size() + " 首", "SUCCESS");
        checkpoint();
    }

    public synchronized void addMatch(TrackMatch match, Track target) {
        requireActive();
        if (target != null) targets.put(matches.size(), target);
        matches.add(match);
    }

    public synchronized void awaitConfirmation() {
        requireActive();
        currentStep = "匹配完成，等待勾选确认";
        log("匹配完成：" + targets.size() + " / " + matches.size() + " 首；尚未创建目标歌单", "INFO");
        status = JobStatus.AWAITING_CONFIRMATION;
        checkpoint();
    }

    public synchronized List<Track> confirm(List<Integer> indices) {
        if (status != JobStatus.AWAITING_CONFIRMATION) {
            throw new ProviderException(HttpStatus.CONFLICT, "MIGRATION_STATE",
                    "任务不在等待确认状态，请勿重复确认");
        }
        if (indices == null || indices.isEmpty()) {
            throw ProviderException.badRequest("请至少选择一首已匹配的歌曲");
        }
        if (indices.size() > matches.size() || new HashSet<>(indices).size() != indices.size()
                || indices.stream().anyMatch(index -> index == null || !targets.containsKey(index))) {
            throw ProviderException.badRequest("所选歌曲无效，请选择不重复的已匹配歌曲");
        }
        List<Integer> ordered = indices.stream().sorted().toList();
        List<Track> selected = ordered.stream().map(targets::get).toList();
        if (targetProvider == ProviderId.NETEASE_MUSIC
                && selected.stream().map(Track::providerTrackId).distinct().count() != selected.size()) {
            throw ProviderException.badRequest("网易云不能重复加入同一首歌曲，请取消重复的匹配项");
        }
        selectedIndices = ordered;
        currentStep = "已确认，准备创建目标歌单";
        log("已确认迁移 " + selected.size() + " 首，跳过 " + (targets.size() - selected.size()) + " 首匹配项", "INFO");
        status = JobStatus.RUNNING;
        checkpoint();
        return selected;
    }

    public synchronized void beginWrite() {
        requireActive();
        writeStarted = true;
        checkpoint();
    }

    public synchronized void targetCreated(CreatedPlaylist created) {
        requireActive();
        createdTarget = new CreatedPlaylist(created.id(), created.name(), created.url(), 0, Map.of());
        checkpoint();
    }

    public synchronized void complete(CreatedPlaylist createdPlaylist) {
        requireActive();
        result = new CreatedPlaylist(createdPlaylist.id(), createdPlaylist.name(), createdPlaylist.url(),
                createdPlaylist.trackCount(), Map.of());
        status = JobStatus.COMPLETED;
        progress = 100;
        currentStep = "迁移完成";
        log("迁移完成：成功写入 " + createdPlaylist.trackCount() + " 首", "SUCCESS");
        releaseConnection();
        checkpoint();
    }

    public synchronized void fail(String message) {
        if (terminal()) return;
        error = message;
        status = JobStatus.FAILED;
        currentStep = "迁移失败";
        if (writeStarted) recoveryNotice = "目标平台可能已发生写入，请核查目标歌单后手动处理，勿自动重试。";
        log(message, "ERROR");
        releaseConnection();
        checkpoint();
    }

    public synchronized void interrupt(String reason) {
        if (terminal()) return;
        status = JobStatus.INTERRUPTED;
        currentStep = writeStarted ? "写入结果待核查" : "任务已中断";
        recoveryNotice = reason + (writeStarted
                ? "；目标平台可能已发生写入，请手动核查，勿自动重试。"
                : "；未开始写入目标平台，请重新连接并匹配。未确认预览不会自动恢复。" );
        error = recoveryNotice;
        log(recoveryNotice, "WARN");
        releaseConnection();
        checkpoint();
    }

    public boolean terminal() {
        return status == JobStatus.COMPLETED || status == JobStatus.FAILED || status == JobStatus.INTERRUPTED;
    }

    private void requireActive() {
        if (terminal()) throw new ProviderException(HttpStatus.CONFLICT, "MIGRATION_STATE", "任务已结束，不会继续执行");
    }

    private void releaseConnection() {
        targetConnection = null;
        targets.clear();
    }

    public synchronized List<Integer> selectedIndicesSnapshot() { return selectedIndices; }
    public synchronized List<LogEntry> logsSnapshot() { return List.copyOf(logs); }
    public synchronized List<TrackMatch> matchesSnapshot() { return List.copyOf(matches); }
    public String id() { return id; }
    public String sessionId() { return sessionId; }
    public String ownerId() { return ownerId; }
    public ProviderId sourceProvider() { return sourceProvider; }
    public ProviderId targetProvider() { return targetProvider; }
    public String sourceUrl() { return sourceUrl; }
    public String requestedName() { return requestedName; }
    public ConnectionMode targetMode() { return targetMode; }
    public ProviderConnection targetConnection() { return targetConnection; }
    public JobStatus status() { return status; }
    public int progress() { return progress; }
    public String currentStep() { return currentStep; }
    public Playlist sourcePlaylist() { return sourcePlaylist; }
    public CreatedPlaylist createdTarget() { return createdTarget; }
    public CreatedPlaylist result() { return result; }
    public String error() { return error; }
    public String recoveryNotice() { return recoveryNotice; }
    public boolean writeStarted() { return writeStarted; }
    public Instant createdAt() { return createdAt; }
}
