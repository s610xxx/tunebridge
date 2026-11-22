package com.tunebridge.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.tunebridge.testsupport.BridgeRequests;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = "spring.datasource.url=jdbc:h2:mem:static_assets;DB_CLOSE_DELAY=-1")
@AutoConfigureMockMvc
class StaticResourceAccessTest {

    private static final Pattern LOCAL_ASSET = Pattern.compile("(?:src|href)=\"(/[^\"]+\\.(?:js|css))\"");

    @Autowired
    private MockMvc mvc;

    @Test
    void servesEveryLocalAssetThePageLoadsToVisitorsWithoutAnAccount() throws Exception {
        List<String> assets = localAssets();
        assertThat(assets).contains("/styles.css", "/app.js", "/playlist-backup.js", "/playlist-batch.js",
                "/history-report.js");
        for (String asset : assets) {
            mvc.perform(BridgeRequests.get(asset)).andExpect(status().isOk());
        }
    }

    private List<String> localAssets() throws IOException {
        try (InputStream input = new ClassPathResource("static/index.html").getInputStream()) {
            String html = new String(input.readAllBytes(), StandardCharsets.UTF_8);
            List<String> assets = new ArrayList<>();
            Matcher matcher = LOCAL_ASSET.matcher(html);
            while (matcher.find()) {
                assets.add(matcher.group(1));
            }
            return assets;
        }
    }
}
