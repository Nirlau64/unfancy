            }, 60000);
        }
    };
    const stopPolling = () => {
        clearInterval(refreshInterval);
        refreshInterval = null;
    };

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPolling();
        else startPolling();
    });

    startPolling();
});
