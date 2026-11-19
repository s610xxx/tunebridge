package com.tunebridge.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tunebridge.domain.ConnectionMode;
import com.tunebridge.domain.CreatedPlaylist;
import com.tunebridge.domain.JobStatus;
import com.tunebridge.domain.MigrationJob;
import com.tunebridge.domain.Playlist;
import com.tunebridge.domain.ProviderConnection;
import com.tunebridge.domain.ProviderId;
import com.tunebridge.domain.Track;
import com.tunebridge.domain.TrackMatch;
import com.tunebridge.provider.ProviderException;
import com.tunebridge.security.AccountService;
import com.tunebridge.web.dto.JobView;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:history_test;DB_CLOSE_DELAY=-1")
class MigrationHistoryTest {

    @Autowired
    private MigrationHistory history;

    @Autowired
    private AccountService accounts;

    private String owner;
    private String otherOwner;

    @BeforeEach
    void registerOwners() {
        owner = account();
        otherOwner = account();
    }

    @Test
    void persistsTheReportForEachOwnerAndHidesItFromEveryoneElse() {
        MigrationJob job = matching("mig_visible");
        JobView stored = history.find(owner, job.id());
        assertThat(stored.readOnly()).isTrue();
        assertThat(stored.status()).isEqualTo(JobStatus.AWAITING_CONFIRMATION.name());
        assertThat(stored.currentStep()).isEqualTo("匹配完成，等待勾选确认");
        assertThat(stored.matches()).hasSize(1);
        assertThat(stored.matches().getFirst().targetTitle()).isEqualTo("晴天");
        assertThat(stored.logs()).isNotEmpty();
        assertThat(stored.target().mode()).isEqualTo(ConnectionMode.DEMO.name());

        assertThatThrownBy(() -> history.find(otherOwner, job.id()))
                .isInstanceOf(ProviderException.class)
                .matches(ex -> ((ProviderException) ex).code().equals("NOT_FOUND"));
        assertThat(history.list(otherOwner, 0, 10).items()).isEmpty();
    }

    @Test
    void keepsTheWholeReportIncludingTheResultAndRecoveryFields() {
        MigrationJob job = matching("mig_completed");
        List<Track> selected = job.confirm(List.of(0));
        job.beginWrite();
        CreatedPlaylist created = new CreatedPlaylist("pl-1", "夏夜循环 · 音桥",
                "https://music.apple.com/playlist/pl-1", 0, Map.of());
        job.targetCreated(created);
        job.complete(new CreatedPlaylist(created.id(), created.name(), created.url(), selected.size(), Map.of()));

        JobView stored = history.find(owner, "mig_completed");
        assertThat(stored.status()).isEqualTo(JobStatus.COMPLETED.name());
        assertThat(stored.result().playlistUrl()).isEqualTo("https://music.apple.com/playlist/pl-1");
        assertThat(stored.result().addedCount()).isEqualTo(1);
        assertThat(stored.result().matchedCount()).isEqualTo(1);
        assertThat(stored.createdTarget().playlistId()).isEqualTo("pl-1");
        assertThat(stored.recoveryNotice()).isNull();

        job.fail("写入被目标平台拒绝");
        assertThat(history.find(owner, "mig_completed").status()).isEqualTo(JobStatus.COMPLETED.name());
    }

    @Test
    void pagesThroughNewestFirstWithoutLeaksBetweenOwners() {
        for (int index = 0; index < 3; index++) {
            matching(owner, "mig_page_" + index);
        }
        matching(otherOwner, "mig_other");

        MigrationHistory.Page first = history.list(owner, 0, 2);
        assertThat(first.items()).hasSize(2);
        assertThat(first.hasMore()).isTrue();
        assertThat(first.offset()).isZero();

        MigrationHistory.Page second = history.list(owner, 2, 2);
        assertThat(second.items()).hasSize(1);
        assertThat(second.hasMore()).isFalse();
        assertThat(second.items().getFirst().id()).startsWith("mig_page_");

        assertThat(history.list(owner, 99, 20).items()).isEmpty();
        assertThat(history.list(owner, 0, 50).items()).hasSize(3);

        // The neighbour sees nothing of this owner's work, and cannot fetch a row by id either.
        assertThat(history.list(otherOwner, 0, 50).items()).hasSize(1);
        assertThatThrownBy(() -> history.find(otherOwner, "mig_page_0"))
                .isInstanceOf(ProviderException.class)
                .matches(ex -> ((ProviderException) ex).code().equals("NOT_FOUND"));
    }

    @Test
    void rejectsNonsensePagingBeforeTouchingTheDatabase() {
        for (int[] paging : new int[][]{{-1, 20}, {0, 0}, {0, 51}, {100_001, 20}}) {
            assertThatThrownBy(() -> history.list(owner, paging[0], paging[1]))
                    .as("offset=%d limit=%d", paging[0], paging[1])
                    .isInstanceOf(ProviderException.class)
                    .matches(ex -> ((ProviderException) ex).code().equals("INVALID_INPUT"));
        }
        assertThatThrownBy(() -> history.find(owner, "no-such-job"))
                .isInstanceOf(ProviderException.class)
                .matches(ex -> ((ProviderException) ex).status() == HttpStatus.NOT_FOUND);
    }

    @Test
    void marksUnfinishedWorkInterruptedOnRestartAndNeverRepeatsTheDecision() {
        MigrationJob waiting = matching("mig_restart_preview");
        MigrationJob writing = matching("mig_restart_write");
        writing.confirm(List.of(0));
        writing.beginWrite();
        MigrationJob finished = matching("mig_restart_done");
        finished.confirm(List.of(0));
        finished.beginWrite();
        finished.complete(new CreatedPlaylist("pl-2", "done", "url", 1, Map.of()));

        history.recoverInterrupted();

        JobView preview = history.find(owner, "mig_restart_preview");
        assertThat(preview.status()).isEqualTo(JobStatus.INTERRUPTED.name());
        assertThat(preview.readOnly()).isTrue();
        assertThat(preview.recoveryNotice()).contains("服务重启，任务已中断").contains("未开始写入");
        assertThat(preview.matches()).as("the matched report stays readable").hasSize(1);

        JobView write = history.find(owner, "mig_restart_write");
        assertThat(write.status()).isEqualTo(JobStatus.INTERRUPTED.name());
        assertThat(write.recoveryNotice()).contains("写入阶段").contains("勿自动重试");

        assertThat(history.find(owner, "mig_restart_done").status()).isEqualTo(JobStatus.COMPLETED.name());

        // A second restart must not rewrite already-resolved rows.
        history.recoverInterrupted();
        assertThat(history.find(owner, "mig_restart_write").recoveryNotice()).contains("写入阶段");
    }

    private MigrationJob matching(String jobId) {
        return matching(owner, jobId);
    }

    private MigrationJob matching(String ownerId, String jobId) {
        ProviderConnection target = new ProviderConnection(ProviderId.APPLE_MUSIC,
                ConnectionMode.DEMO, "demo", Map.of());
        MigrationJob job = new MigrationJob(jobId, "session-" + jobId, ownerId, ProviderId.QQ_MUSIC,
                ProviderId.APPLE_MUSIC, "demo://builtin", "夏夜循环 · 音桥", target, history::save);
        Track source = Track.of("dq-1", "晴天", "周杰伦", "叶惠美", 269);
        Track candidate = new Track("1440857792", "晴天", "周杰伦", "叶惠美", 269, "", 0);
        job.start();
        job.sourceLoaded(new Playlist("demo-qq", "夏夜循环", "", "", "阿桥", "demo://builtin", List.of(source)));
        job.addMatch(TrackMatch.matched(source, candidate, 0.91, false, "标题与歌手一致"), candidate);
        job.awaitConfirmation();
        return job;
    }

    private String account() {
        String username = "h" + UUID.randomUUID().toString().replace("-", "").substring(0, 15);
        accounts.register(username, "history-test-password", null);
        return accounts.loadUserByUsername(username).id();
    }
}
