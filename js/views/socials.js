/**
 * View Controller: Socials
 */
import { DataStatusSource, DataStatus, fetchAPI } from '../api.js';
import { CONFIG, renderError, renderDataStatusFooter } from '../utils.js';

// Keeps the last successfully loaded YouTube payload so a failed refresh can
// still show the cached video (status: stale).
const ytSource = new DataStatusSource((signal) => fetchAPI(CONFIG.API.YT_RSS, false, signal));

export async function initSocials(signal = null) {
    const ytContainer = document.getElementById('socials-yt');
    if (!ytContainer) return;

    try {
        const ytRes = await ytSource.load(signal);

        if (signal?.aborted) return;
        const ytData = ytRes.data;

        if (ytData?.status === 'ok' && ytData.items.length > 0) {
            const vidId = ytData.items[0].guid.split(':').pop();

            while (ytContainer.firstChild) ytContainer.removeChild(ytContainer.firstChild);

            const wrap = document.createElement('div');
            wrap.className = 'yt-wrap';

            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube-nocookie.com/embed/${vidId}?rel=0&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`;
            iframe.title = 'YouTube video player';
            iframe.frameBorder = '0';
            iframe.allow = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
            iframe.allowFullscreen = true;

            wrap.appendChild(iframe);
            ytContainer.appendChild(wrap);
            renderDataStatusFooter(ytContainer, ytRes, { retryFn: () => initSocials() });
        } else if (ytRes.status === DataStatus.ERROR) {
            console.error("YouTube loading error", ytRes.error);
            renderError(ytContainer, "YouTube konnte nicht geladen werden.", () => initSocials());
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("YouTube loading error", e);
        renderError(ytContainer, "YouTube konnte nicht geladen werden.", () => initSocials());
    }

    // Instagram - Prevent duplicate script injection
    if (window.instgrm) {
        window.instgrm.Embeds.process();
    } else if (!document.getElementById('instagram-embed-script')) {
        const s = document.createElement('script');
        s.id = 'instagram-embed-script';
        s.src = "https://www.instagram.com/embed.js";
        s.async = true;
        document.body.appendChild(s);
    }
}
