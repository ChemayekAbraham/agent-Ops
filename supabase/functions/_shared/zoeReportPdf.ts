import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// Welile wordmark (163 x 59 PNG, transparent background)
const LOGO_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKMAAAA7CAMAAAAgh8qcAAAAflBMVEUAAABMFo5HIW85GmH4B/7+9/5PKmzuXf5gJ5z5nP49EoWjFvacXN1pTo1eR3RhMpFuS5k4GVpTI2yPWa78AAAKAPRxTJ+rV/RXR2hjA/NkF5yMYawB/wBjUWDOa++LXqwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGKbKvAAAAIHRSTlMA/vz6CAqfG2EU/x1X6OiZnqBqVwIIaCmeGCTrAWZHlxMC1iAAAAiHSURBVHjavZqJcts4DEBFAKRO27J8xmmS///L5U3wcOLs7lSdaWuZoh5xE3TX/dXrwv9/+c2T40ujzv+dUOYfL/9qeZf/jXHOeN46Gvu3gvHtXy+2hXI8qq2jl6eQCvWl+C0AfedajlEva1qPVuMPAwA3+QtEjQTQxzsDCiH0nS3eIbDXi5DSTIeYQWYikwMaRhxeZRys0ACOUak4TUay+JE0A3YZOL8042qfhit3oWFglL0BNJTyNZOUds0oAMMdBKEFqe9Gxlkjmjvw+RLj3skRkiqP+oaiJFP9CqMp7F8WI0z6iZzRvCK9Qwk7KcDXKzMSOsvAJdzYrKZOXCzCvnJ5jVG58Yzx4VwGI+Loh+jrpRjhEADWtGqzZBV8vEf/yjTi+wsDQGTslr2+TpKCoR9+x7iAFxP45zcvWG/NNETGffeqYkrGztLpvyhEosAIv2OckxhFCgvSI5pbxvf/6D/fmyNWuk6oVCwD4DeqARiixTuX66PBB0b7hj+BkeZhGLZtHvPQr75hTF4V56yCsZl1GG5E2bL98CVH9k8fsDUfzb2yNmFiwsbns5GvYiR6e6S6QD1jlPKO/oLrSCWjcC4hoxS8sqEx30UPQ2+2hhNPMgkSo/EwRnnXPjOmxBgsNmeU9y7Oqpd4lbJwMTf8XiJFB2SMdMM4kw0CgJRySoPxzaYBVTJCzji6FOrXbf63BEYR1tQz69PPo0sIgVFgBOn9TCJdu/CiQwRgjMKuA+UlPC4ajGNcdgjI4VvlPovJTilRJMaDtS7GYYopad5hZcURBYRszuQeGQ/mvcJNqK8bM/EdT7ls2ei+PhBjBBQmj5zSK9DGQxVuTJPYEYtO+ZXiaYORhBWOXtkcKoT41MrTk4kn7n742oWSaDwm/RHTn5M0Wxm6Nd+OmZYLF2sxznq9RlPoVbdvhQqVG8/kGRVn1ExKmwQy89MTPDj0LgR1JsXgIfrmWDIGH1m9eCZf3u2ZXy6sQhTBfLycrXmaWaN0USj6Yq8H40QnYMofQ45ApuJk4Jv3zZKR4nhvkCkRxjpFRvvx0dEXEW6SXbQAOPRM3MaEDszP9SR2/3FieUznos/wiGe81nJ8i9aL66X7I7v4GWK9t7AMbvxoF8O0meQdfHUo8EgoMDmW/qJ75558N48MFUFcfLpLoExEYY0PXN/R+qiODZvxoMM7RfrQMl5EoSgvuMT5aXb93mbtq9XVc1TY8jilF4Ds53fvPg4lLX4xxDaE5uoGrAYD5zFzYOMJ9NPOEMXahS9L1+ztm4UQHXc5oq+iPpGklP+7dOTFezdz7Wo4Ls3EyKZOnVxfOkgHZt8iOFGckH8P11+9FWNbBA8pUeE956JOXwPrrk11/nTtXxvikBFDJGj9sDaVdD6eYGwgjY45oi1TBXvnpQkT4vJNFnTTySo7VxLtk05AX6oExWZ/b8hhzdDYvRJ8xxnjMls0ZDcNHShGmsn6cstnPsskIzxldmD+FcAZgbFwq5uPWGBIjVIIUnNGNZozjF7DXbVpFTUaeqtqM18S4IzJVthMihH0jWocTP12BMZYs1qkEFtaPtT3WjGUuvDJtIMbglvbf6BX/hCzX0xHZjWgzwVrbjPgjI9OtmZSlsVNYORRVTH0nlsC7WuCTffn6CDuFmrH0GYjhyuv6qYBUUdvz4L1rMF6fzjYBpO19Q9fPGOFbRtMhupVbdi6yqkAUdjw1DZdX05eMcS4Z55LRit8Up41pUVLax1X1alcr23a4qOH4GP0l31s05UiuDipqMygZJ+M5rL+kMM8uxl8l1DBek1l9a6sovGfN0N8xntyIiUvI9obwKOsNdhZlahs9FE2QSFh0K79jhNwe24x+U/zgs/YFoyl3qpvCF8y8zLPLvXd5e5f4AKoYi7oHXW20Y+bvpj05U5Rhh507jdurUQnusnHqWthN23XxrQcatMWoW1FkV7GnkiO6feGKfFp1uknb+bgt9/1+t0oXUjGrdoYsOWQy2SDtLRevjTP1q9GQs7aMkUpN+iIjFfeW8cqW4Z7RXDSurn1MLcasX+FvHoJhpFuLjP1y01/Qf1RhDbPfBk65Ua+McR+21mHIl0E6SxqvR7+zOfjWMsc5+hTajvjs3myXfLPRB0VihJJRlIxF3SFTYgPcem2LsrPHJ5PfnhaM6MJqVzAGn9i430I/u32x3xKpuJXnD6X86ZsZXBl2DF0To8bej53axw2nNYetwJFFaZy3W5kuRaxS/Ox9k3GNVYtnJNZUAt/qweTVoSMVZLZk+1/euMlCOzvrOWQhkjcXoNoJxP1MztiV1VSqakONlqpFn25yxr4rFmtubufsgKpZpLiF1H3kW2J8C33XgtFtDnzfyaTC0oUzRmD9WGakKXWSAkBoMhZ1VOj3zJ5xiocIS3JsP4bWJ1V2qKh46xfmRo5EKI6x6koptUlVtC0MD/iqNZ7mEdsRh2OHctLQlCqzIcQ4mOWHrLEdzlALQuj6rEfHzj76Hbh2Ymr2Qn0+s1Q2ZL2np9jnjzR1N19LAS/N4xLWOmPl2RxfFvS4x5JRxSbRjjf3MIuBeXlGdkdo5h7y9rRvmgzV2ZjNAEmIeMyPqjNGp8esyhx8Xwz5+d4MvPdqEWV+RuPeVR1O2uONsToK8kexvpDKTzsH2xJls5HNlFxHPbrklD1J9rACkxBHOhfaMy/MT1Z9a751Wi934fBD/zvkvxAYwxdL5mbcjOw6Cm5t6vM1zQoHmouTfvvFVpD0rlho/ACApBwGe/S5dbJ1OGw7WnH0SQ/s85kdY7F8XS6u9uF1GaufRsgh1MT1if6TI2EyP+OYW+f4OtgZadz4/OWY3h3u9o0jRertQVzj5xvU/EnHfOxePFnPVtyp9fjDmF4p9ah+WPD9bzao+6sXzTSPv33o0f3lS5sJ1T/QaB08/wMsYELtbo6ZMQAAAABJRU5ErkJggg==";

const BRAND_DARK = rgb(0.298, 0.086, 0.588); // #4C1696
const BRAND = rgb(0.424, 0.129, 0.769); // #6C21C4
const GOLD = rgb(0.937, 0.69, 0.18); // #EFB02E
const INK = rgb(0.059, 0.09, 0.165);
const SUB = rgb(0.392, 0.455, 0.545);
const LINE = rgb(0.855, 0.816, 0.906);
const SOFT = rgb(0.965, 0.953, 0.984);
const ZEBRA = rgb(0.98, 0.984, 0.992);
const WHITE = rgb(1, 1, 1);

const PAGE_W = 595;
const PAGE_H = 842;
const M = 36;
const R = PAGE_W - M;
const CONTENT_W = R - M;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

const safeAscii = (v: unknown, fallback = "-"): string => {
  const s = String(v ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00B7/g, "|")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
  return s || fallback;
};

function fitText(text: string, font: any, size: number, maxWidth: number): string {
  let out = safeAscii(text, "");
  if (!out) return "-";
  while (out.length > 3 && font.widthOfTextAtSize(out, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out === safeAscii(text, "") ? out : `${out.trimEnd()}...`;
}

export interface ZoeSharedReportPdfData {
  report_title?: string;
  source?: string;
  period_label?: string;
  generated_at?: string;
  sender_name?: string;
  sender_email?: string;
  recipient_name?: string;
  recipient_email?: string;
  how_counted?: string;
  row_count?: number;
  headers?: string[];
  rows?: Array<Array<string | number | null>>;
}

/**
 * Renders a branded Welile A4 PDF for "Report shared from Zoe" with:
 *   - Purple header banner + embedded Welile logo
 *   - Dates, generated time, who generated it, recipient, and row count
 *   - "How this was counted" note
 *   - Exact rows returned by Zoe
 *   - Page-numbered footer (`Page X of Y`) on every page
 */
export async function renderZoeReportPdf(data: ZoeSharedReportPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const title = safeAscii(data.report_title, "Zoe Staff Operations Report");
  const source = safeAscii(data.source, "Official Welile Read-Only Report");
  const periodLabel = safeAscii(data.period_label, "Current Period");
  const generatedAt = safeAscii(data.generated_at, new Date().toISOString());
  const senderLabel = safeAscii(
    data.sender_email ? `${data.sender_name || "Staff"} (${data.sender_email})` : data.sender_name,
    "Authenticated Staff Member",
  );
  const howCounted = safeAscii(
    data.how_counted,
    `Counted directly from official server source (${source}) for ${periodLabel}.`,
  );

  const headers =
    Array.isArray(data.headers) && data.headers.length > 0
      ? data.headers.map((h) => safeAscii(h, "Column"))
      : ["Metric", "Value"];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const rowCount = typeof data.row_count === "number" ? data.row_count : rows.length;

  pdf.setTitle(`${title} (${periodLabel})`);
  pdf.setAuthor("Welile Technologies Limited");

  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let logoImage: any = null;
  try {
    logoImage = await pdf.embedPng(LOGO_BASE64);
  } catch {
    logoImage = null;
  }

  const rowsPerPage = 24;
  const rowChunks: Array<Array<Array<string | number | null>>> = [];
  if (rows.length === 0) {
    rowChunks.push([]);
  } else {
    for (let i = 0; i < rows.length; i += rowsPerPage) {
      rowChunks.push(rows.slice(i, i + rowsPerPage));
    }
  }

  const totalPages = rowChunks.length;

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const chunk = rowChunks[pageIdx];
    const rowOffset = pageIdx * rowsPerPage;

    // 1. Purple Welile Header Banner
    const headerH = 74;
    const headerBottom = PAGE_H - headerH;
    page.drawRectangle({
      x: 0,
      y: headerBottom,
      width: PAGE_W,
      height: headerH,
      color: BRAND_DARK,
    });
    page.drawRectangle({
      x: 0,
      y: headerBottom,
      width: 10,
      height: headerH,
      color: BRAND,
    });
    page.drawRectangle({
      x: 0,
      y: headerBottom,
      width: PAGE_W,
      height: 3.5,
      color: GOLD,
    });

    let titleX = M;
    if (logoImage) {
      const logoH = 26;
      const logoW = (logoImage.width * logoH) / logoImage.height;
      page.drawRectangle({
        x: M,
        y: PAGE_H - 42,
        width: logoW + 8,
        height: logoH + 6,
        color: WHITE,
      });
      page.drawImage(logoImage, {
        x: M + 4,
        y: PAGE_H - 39,
        width: logoW,
        height: logoH,
      });
      titleX = M + logoW + 18;
    }

    page.drawText(
      fitText(pageIdx === 0 ? title : `${title} (Continued)`, bold, 13, PAGE_W - titleX - M),
      {
        x: titleX,
        y: PAGE_H - 28,
        size: 13,
        font: bold,
        color: WHITE,
      },
    );
    page.drawText(
      fitText(`Official Source: ${source}`, reg, 8.5, PAGE_W - titleX - M),
      {
        x: titleX,
        y: PAGE_H - 43,
        size: 8.5,
        font: reg,
        color: SOFT,
      },
    );
    page.drawText(
      fitText(`Report shared from Zoe | Dates: ${periodLabel} | Rows: ${rowCount}`, reg, 8, PAGE_W - titleX - M),
      {
        x: titleX,
        y: PAGE_H - 57,
        size: 8,
        font: reg,
        color: WHITE,
      },
    );

    let cursorY = headerBottom - 14;

    // 2. Metadata Box (Dates, Generated Time, Generated By, Row Count)
    const metaBoxH = 42;
    page.drawRectangle({
      x: M,
      y: cursorY - metaBoxH,
      width: CONTENT_W,
      height: metaBoxH,
      color: SOFT,
      borderColor: LINE,
      borderWidth: 0.8,
    });

    const metaCols: Array<[string, string]> = [
      ["DATES / PERIOD", periodLabel],
      ["GENERATED TIME", generatedAt],
      ["GENERATED BY", senderLabel],
      ["ROW COUNT", `${rowCount} ${rowCount === 1 ? "row" : "rows"}`],
    ];
    const metaColW = CONTENT_W / metaCols.length;
    metaCols.forEach(([label, val], idx) => {
      const colX = M + 8 + idx * metaColW;
      page.drawText(label, {
        x: colX,
        y: cursorY - 14,
        size: 6.5,
        font: bold,
        color: SUB,
      });
      page.drawText(fitText(val, bold, 8, metaColW - 12), {
        x: colX,
        y: cursorY - 28,
        size: 8,
        font: bold,
        color: INK,
      });
    });

    cursorY -= metaBoxH + 10;

    // 3. "How this was counted" note on page 1
    if (pageIdx === 0) {
      const noteBoxH = 32;
      page.drawRectangle({
        x: M,
        y: cursorY - noteBoxH,
        width: CONTENT_W,
        height: noteBoxH,
        color: SOFT,
        borderColor: BRAND,
        borderWidth: 0.8,
      });
      page.drawText("HOW THIS WAS COUNTED:", {
        x: M + 8,
        y: cursorY - 11,
        size: 6.8,
        font: bold,
        color: BRAND_DARK,
      });
      page.drawText(fitText(howCounted, reg, 7.5, CONTENT_W - 16), {
        x: M + 8,
        y: cursorY - 23,
        size: 7.5,
        font: reg,
        color: INK,
      });
      cursorY -= noteBoxH + 12;
    }

    // 4. Data Table Header
    const numColW = 24;
    const dataColW = (CONTENT_W - numColW) / Math.max(1, headers.length);
    const thH = 18;
    page.drawRectangle({
      x: M,
      y: cursorY - thH,
      width: CONTENT_W,
      height: thH,
      color: BRAND,
    });
    page.drawText("#", {
      x: M + 6,
      y: cursorY - 12,
      size: 7.5,
      font: bold,
      color: WHITE,
    });
    headers.forEach((h, colIdx) => {
      page.drawText(fitText(h, bold, 7.5, dataColW - 8), {
        x: M + numColW + colIdx * dataColW + 4,
        y: cursorY - 12,
        size: 7.5,
        font: bold,
        color: WHITE,
      });
    });
    cursorY -= thH;

    // 5. Data Rows
    const rowH = 17;
    if (chunk.length === 0) {
      page.drawRectangle({
        x: M,
        y: cursorY - rowH,
        width: CONTENT_W,
        height: rowH,
        color: WHITE,
        borderColor: LINE,
        borderWidth: 0.5,
      });
      page.drawText("No rows returned for this period.", {
        x: M + 8,
        y: cursorY - 12,
        size: 7.5,
        font: reg,
        color: SUB,
      });
      cursorY -= rowH;
    } else {
      chunk.forEach((r, rIdx) => {
        const globalIdx = rowOffset + rIdx;
        page.drawRectangle({
          x: M,
          y: cursorY - rowH,
          width: CONTENT_W,
          height: rowH,
          color: rIdx % 2 === 1 ? ZEBRA : WHITE,
          borderColor: LINE,
          borderWidth: 0.4,
        });
        page.drawText(String(globalIdx + 1), {
          x: M + 6,
          y: cursorY - 11.5,
          size: 7,
          font: reg,
          color: SUB,
        });
        headers.forEach((_, colIdx) => {
          const rawVal = r[colIdx];
          const cellStr = rawVal === null || rawVal === undefined ? "-" : String(rawVal);
          page.drawText(fitText(cellStr, reg, 7.2, dataColW - 8), {
            x: M + numColW + colIdx * dataColW + 4,
            y: cursorY - 11.5,
            size: 7.2,
            font: reg,
            color: INK,
          });
        });
        cursorY -= rowH;
      });
    }

    // 6. Page-Numbered Footer ("Page X of Y")
    const footerY = 26;
    page.drawLine({
      start: { x: M, y: footerY + 11 },
      end: { x: R, y: footerY + 11 },
      thickness: 0.6,
      color: LINE,
    });
    page.drawText(
      fitText(`Welile Technologies Limited | ${source} | Dates: ${periodLabel}`, reg, 7, CONTENT_W * 0.58),
      {
        x: M,
        y: footerY,
        size: 7,
        font: reg,
        color: SUB,
      },
    );
    const footerRight = safeAscii(
      `Generated by ${senderLabel} (${generatedAt}) | Page ${pageIdx + 1} of ${totalPages}`,
    );
    const rightW = bold.widthOfTextAtSize(footerRight, 7);
    page.drawText(footerRight, {
      x: Math.max(M + CONTENT_W * 0.58, R - rightW),
      y: footerY,
      size: 7,
      font: bold,
      color: INK,
    });
  }

  return await pdf.save();
}
