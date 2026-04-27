import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Delay between CheapShark API calls to respect rate limits
const CHEAPSHARK_API_DELAY_MS = 600;

// CheapShark store IDs we care about: 1 = Steam, 7 = GOG, 25 = Epic Games Store
const ALLOWED_STORE_IDS = ['1', '7', '25'];

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Returns two search-friendly variants of a game title:
 *  - title1: full title with the Ukrainian spelling of Chornobyl corrected
 *  - title2: shortened title (up to the first colon/dash, trailing " 1" removed)
 */
function normalizeGameTitle(raw: string): [string, string] {
  let title1 = raw.trim();
  if (title1.includes('Chornobyl')) title1 = title1.replace('Chornobyl', 'Chernobyl');
  const title2 = title1.split(/[:\-]/)[0].trim().replace(/\s+1$/i, '');
  return [title1, title2];
}

async function syncOldestGames() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    Deno.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1. Find the Steam platform ID
  const { data: steamPlatform } = await supabase
    .from('platform')
    .select('id')
    .ilike('name', '%steam%')
    .limit(1)
    .maybeSingle();

  const targetPlatformId = steamPlatform?.id;
  if (!targetPlatformId) {
    console.error('No Steam platform found');
    Deno.exit(1);
  }

  // 2. Take the 20 oldest games (those never synced first)
  const { data: games } = await supabase
    .from('game')
    .select('id, title')
    .order('last_sync', { ascending: true, nullsFirst: true })
    .limit(20);

  if (!games || games.length === 0) {
    console.log('All games are up to date.');
    return;
  }

  console.log(`Processing batch of ${games.length} games...`);

  for (const game of games) {
    try {
      const [title1, title2] = normalizeGameTitle(game.title);

      await delay(CHEAPSHARK_API_DELAY_MS);
      let res = await fetch(
        `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(title1)}`
      );
      let data = await res.json();

      if (!Array.isArray(data) || data.length === 0) {
        await delay(CHEAPSHARK_API_DELAY_MS);
        res = await fetch(
          `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(title2)}`
        );
        data = await res.json();
      }

      if (Array.isArray(data) && data.length > 0) {
        const tFull = title1.toLowerCase();
        const tShort = title2.toLowerCase();
        const matchedGame =
          data.find((g: any) => g.external.toLowerCase() === tFull) ||
          data.find((g: any) => g.external.toLowerCase() === tShort);

        if (matchedGame) {
          await delay(CHEAPSHARK_API_DELAY_MS);
          const dealRes = await fetch(
            `https://www.cheapshark.com/api/1.0/games?id=${matchedGame.gameID}`
          );
          const detail = await dealRes.json();
          const validDeals =
            detail.deals?.filter((d: any) => ALLOWED_STORE_IDS.includes(d.storeID)) || [];

          const finalPrice =
            validDeals.length > 0 ? validDeals[0].price : matchedGame.cheapest;

          if (finalPrice) {
            const { error: insertError } = await supabase.from('price_history').insert({
              game_id: game.id,
              price: parseFloat(finalPrice),
              platform_id: targetPlatformId,
              recorded_at: new Date().toISOString(),
            });
            if (insertError) {
              console.error(`Failed to insert price for ${game.title}:`, insertError.message);
              continue;
            }
            console.log(`Updated: ${game.title} -> $${finalPrice}`);
          }
        }
      }

      // Update last_sync even when no price was found, so the next run picks different games
      await supabase
        .from('game')
        .update({ last_sync: new Date().toISOString() })
        .eq('id', game.id);
    } catch (e: any) {
      console.error(`Error on ${game.title}:`, e.message);
    }
  }

  console.log('Batch finished.');
}

await syncOldestGames();
