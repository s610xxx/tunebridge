package com.tunebridge.provider.netease;

import com.tunebridge.provider.ProviderException;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** 只依赖 zxing core，把二维码直接画成 SVG，避免引入 AWT 与图片编码依赖。 */
public final class QrCodeSvg {
    private static final int QUIET_ZONE = 3;

    private QrCodeSvg() {
    }

    public static String render(String content) {
        BitMatrix matrix;
        try {
            matrix = new QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 0, 0, Map.of(
                    EncodeHintType.CHARACTER_SET, StandardCharsets.UTF_8.name(),
                    EncodeHintType.MARGIN, QUIET_ZONE,
                    EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M));
        } catch (WriterException | IllegalArgumentException ex) {
            throw ProviderException.upstream("登录二维码生成失败，请刷新后重试");
        }
        int width = matrix.getWidth();
        StringBuilder path = new StringBuilder(width * 12);
        for (int y = 0; y < matrix.getHeight(); y++) {
            int x = 0;
            while (x < width) {
                if (!matrix.get(x, y)) {
                    x++;
                    continue;
                }
                int run = 1;
                while (x + run < width && matrix.get(x + run, y)) {
                    run++;
                }
                path.append("M").append(x).append(' ').append(y).append("h").append(run).append("v1h-").append(run).append("z");
                x += run;
            }
        }
        return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + width + " " + matrix.getHeight()
                + "\" shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"网易云登录二维码\">"
                + "<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/><path d=\"" + path + "\" fill=\"#000000\"/></svg>";
    }
}
