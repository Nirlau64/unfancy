document.addEventListener('DOMContentLoaded', () => {
  // --- YouTube --- //
  const YOUTUBE_CHANNEL_ID = 'UCmr2wtpiZuDvwpShCNF9tng'; // Corrected channel ID provided by user
  const YOUTUBE_RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
  const YOUTUBE_API_URL = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(YOUTUBE_RSS_URL)}`;
  const youtubeContainer = document.getElementById('latest-youtube-video');

  fetch(YOUTUBE_API_URL)
    .then(response => response.json())
    .then(data => {
      if (data.status === 'ok' && data.items.length > 0) {
        const videoId = data.items[0].guid.split(':').pop();
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${videoId}`;
        iframe.title = 'Neuestes YouTube-Video';
        iframe.setAttribute('allowfullscreen', '');
        iframe.setAttribute('loading', 'lazy');
        iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
        
        const videoWrapper = document.createElement('div');
        videoWrapper.className = 'yt-16x9';
        videoWrapper.appendChild(iframe);
        youtubeContainer.innerHTML = ''; // Clear previous content
        youtubeContainer.appendChild(videoWrapper);
      } else {
        youtubeContainer.textContent = 'Konnte neuestes Video nicht laden.';
      }
    })
    .catch(error => {
      console.error('YouTube Fetch Error:', error);
      youtubeContainer.textContent = 'Fehler beim Laden des Videos.';
    });

    // --- Instagram --- //
    // The dynamic fetch for Instagram is unreliable. 
    // We ensure the static embed script is loaded for the hardcoded post.
    if (window.instgrm) {
      window.instgrm.Embeds.process();
    } else {
      const instaScript = document.createElement('script');
      instaScript.async = true;
      instaScript.src = "https://www.instagram.com/embed.js";
      instaScript.onload = () => {
        if (window.instgrm) {
          window.instgrm.Embeds.process();
        }
      };
      document.body.appendChild(instaScript);
    }
});