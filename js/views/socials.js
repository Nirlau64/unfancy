/**
 * View Controller: Socials
 */
import { fetchAPI } from '../api.js';
import { CONFIG, renderError } from '../utils.js';

export async function initSocials() {
    const ytContainer = document.getElementById('socials-yt');
    if (!ytContainer) return;

    try {
        const ytData = await fetchAPI(CONFIG.API.YT_RSS, false);
        if (ytData.status === 'ok' && ytData.items.length > 0) {
            const vidId = ytData.items[0].guid.split(':').pop();
            
            while (ytContainer.firstChild) ytContainer.removeChild(ytContainer.firstChild);

            const wrap = document.createElement('div');
            wrap.className = 'yt-wrap';
            
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube-nocookie.com/embed/${vidId}?rel=0&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`;
            iframe.title = 'YouTube video player';
            iframe.frameBorder = '0';
            iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
            iframe.allowFullscreen = true;
            
            wrap.appendChild(iframe);
            ytContainer.appendChild(wrap);
        }
    } catch (e) {
        console.error("YouTube loading error", e);
        renderError(ytContainer, "YouTube konnte nicht geladen werden.", initSocials);
    }

    // Instagram
    if (window.instgrm) {
        window.instgrm.Embeds.process();
    } else {
        const s = document.createElement('script');
        s.src = "https://www.instagram.com/embed.js";
        s.async = true;
        document.body.appendChild(s);
    }
}
