            fetch('https://ddragon.leagueoflegends.com/api/versions.json', { signal: AbortSignal.any([AbortSignal.timeout(10000), signal].filter(Boolean)) }).then(r => r.json()),
            fetch('https://static.developer.riotgames.com/docs/lol/queues.json', { signal: AbortSignal.any([AbortSignal.timeout(10000), signal].filter(Boolean)) }).then(r => r.json())
        ]);
        
        if (signal?.aborted) return;

        const patch = versions[0];
        const queueMap = {};
        queues.forEach(q => queueMap[q.queueId] = q.description || `Queue ${q.queueId}`);

        const [champRes, data] = await Promise.all([
            fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`, { signal: AbortSignal.any([AbortSignal.timeout(15000), signal].filter(Boolean)) }).then(r => r.json()),
            fetchAPI(CONFIG.API.LOL, false, signal)
        ]);
