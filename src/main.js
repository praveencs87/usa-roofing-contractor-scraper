import { armKillSwitch, disarmKillSwitch } from './utils/timeoutManager.js';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'roofing contractor', 
        location = 'Miami, FL', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'US'
    });

    log.info(`Searching YellowPages US for "${keyword}" in "${location}"`);
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            await page.waitForSelector('.search-results, .v-card, .result', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM'));

            const title = await page.title();
            if (title.includes('Attention Required') || title.includes('Just a moment')) {
                throw new Error('Blocked by Cloudflare/WAF. Retrying with residential proxy...');
            }

            // YellowPages US result cards
            const items = await page.$$('.result, .v-card');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, .business-name, a.business-name span');
                if (!nameElement) continue;
                const contractorName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.adr, .street-address, .locality');
                const addressText1 = await item.$('.street-address') ? await (await item.$('.street-address')).innerText() : '';
                const addressText2 = await item.$('.locality') ? await (await item.$('.locality')).innerText() : '';
                const address = `${addressText1} ${addressText2}`.trim().replace(/\s+/g, ' ');

                // Phones
                const phoneElement = await item.$('.phones.phone, .phone');
                const phone = phoneElement ? (await phoneElement.innerText()).trim() : '';

                // Ratings (e.g. "5.0")
                const ratingElement = await item.$('.ratings .rating, .result-rating');
                const ratingClass = ratingElement ? await ratingElement.getAttribute('class') : '';
                let rating = '';
                if(ratingClass && ratingClass.includes('rating-')) {
                     const match = ratingClass.match(/rating-([\d]+)/);
                     if(match && match[1]) rating = (parseInt(match[1])/10).toString();
                } else if(ratingElement) {
                     rating = await ratingElement.innerText();
                }
                
                // Reviews count
                const reviewElement = await item.$('.ratings .count');
                const reviews = reviewElement ? (await reviewElement.innerText()).trim() : '';

                // Services
                const categoriesElement = await item.$('.categories');
                const services = categoriesElement ? (await categoriesElement.innerText()).trim() : keyword;
                
                // Website
                const websiteElement = await item.$('a.track-visit-website, .links a[href^="http"]');
                const website = websiteElement ? await websiteElement.getAttribute('href') : '';
                
                const urlElement = await item.$('h2 a.business-name, a.business-name');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.yellowpages.com').toString() : listingUrl;

                if (contractorName && contractorName.length > 1) {
                    const record = {
                        contractorName,
                        services,
                        address,
                        phone,
                        website,
                        rating: `${rating} ${reviews}`.trim(),
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${contractorName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('a.next, .pagination .next');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.yellowpages.com').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const startUrl = `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(keyword)}&geo_location_terms=${encodeURIComponent(location)}`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Done! Extracted ${extractedCount} US roofing leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
