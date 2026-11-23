package com.tunebridge.provider.apple;

/** Apple 网页版的抓取接缝：测试用替身注入，生产走 HTTP。 */
public interface AppleBundleSource {

    /** 网页播放器入口页 HTML，里面有打包脚本的地址。 */
    String html();

    String script(String url);
}
