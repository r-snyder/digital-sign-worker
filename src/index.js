import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import moment from 'moment-timezone';

export default {
  async fetch(request, env, ctx) {
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log('Scheduled event started...');
    const startTime = Date.now(); // Start timer
    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_KEY = env.SUPABASE_KEY;
    console.log(SUPABASE_URL)
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const EVENTS_CACHE_PREFIX = 'kp_event_hash_';

    await fetchAndProcessEvents(env, supabase, EVENTS_CACHE_PREFIX);
    const endTime = Date.now(); // End timer
    const elapsedTime = endTime - startTime;
    console.log(`Scheduled event complete. Elapsed time: ${elapsedTime} ms.`);
  }
};

async function fetchAndProcessEvents(env, supabase, cachePrefix) {
  console.log('Fetching and processing events...');
  const startTime = Date.now(); // Start timer

  const baseUrl = 'https://www.showpass.com/api/public/events/?venue__in=11799';
  let url = baseUrl;
  let apiEvents = [];

  // Fetch all events from the API
  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.statusText}`);
    }
    const eventData = await response.json();
    apiEvents = apiEvents.concat(eventData.results);

    url = eventData.next; // Update the URL to the next page
  }

  // Filter out unpublished API events
  apiEvents = apiEvents.filter(event => event.is_published);

  // Fetch all events from Supabase
  const { data: supabaseEvents, error: fetchError } = await supabase.from('events').select('*');
  if (fetchError) {
    throw new Error('Error fetching existing events: ' + fetchError.message);
  }

  // Identify unpublished events to delete and process
  const unpublishedEvents = supabaseEvents.filter(supabaseEvent =>
    !apiEvents.some(apiEvent => apiEvent.id === supabaseEvent.id)
  );

  // Batch delete unpublished events and related operations
  await Promise.all(unpublishedEvents.map(async (event) => {
    console.log(`Deleting unpublished event: ${event.id}`);

    // Delete event from Supabase
    const deleteEventPromise = supabase.from('events').delete().eq('id', event.id);

    // Delete image from Supabase storage if it exists
    const deleteImagePromise = event.supabase_image_banner ?
      supabase.storage.from('images').remove([event.supabase_image_banner]) :
      Promise.resolve();

    // Delete KV hash entries
    const cacheKey = `${cachePrefix}${event.id}`;
    const newCacheKey = `${cacheKey}_v2`; // assuming hashVersion is defined globally
    const deleteKVPromise = Promise.all([
      env.KP_EVENTS.delete(cacheKey),
      env.KP_EVENTS.delete(newCacheKey)
    ]);

    // Wait for all operations to complete
    await Promise.all([deleteEventPromise, deleteImagePromise, deleteKVPromise]);
    // Remove the event from supabaseEvents map to avoid further processing
    supabaseEvents.splice(supabaseEvents.indexOf(event), 1);
    console.log(`Deleted event ${event.id} and related data successfully.`);
  }));

  // Combine events from Supabase and API, prefer Supabase data
  const mergedEventsMap = new Map();
  supabaseEvents.forEach(event => mergedEventsMap.set(event.id, event));
  apiEvents.forEach(event => {
    if (!mergedEventsMap.has(event.id)) {
      mergedEventsMap.set(event.id, event);
    }
  });

  // Process merged events
  const currentDateAST = moment().tz('America/Halifax');
  await Promise.all(Array.from(mergedEventsMap.values()).map(async (event, index) => {
    console.log(`Processing event: ${event.id} (${index + 1} of ${mergedEventsMap.size})`);

    const eventStartDateAST = moment(event.starts_on).tz('America/Halifax');

    // Check if the event start date has passed
    if (eventStartDateAST.isBefore(currentDateAST)) {
      console.log(`Event ${event.id} has already started. Deleting...`);
      await supabase.from('events').delete().eq('id', event.id);
      console.log(`Event ${event.id} deleted successfully.`);

      // Delete the image from Supabase storage if it exists
      if (event.supabase_image_banner) {
        await supabase.storage.from('images').remove([event.supabase_image_banner]);
        console.log(`Image for event ${event.id} deleted successfully.`);
      }

      // Delete the event hash from KV
      const cacheKey = `${cachePrefix}${event.id}`;
      const newCacheKey = `${cacheKey}_v2`; // assuming hashVersion is defined globally
      await Promise.all([
        env.KP_EVENTS.delete(cacheKey),
        env.KP_EVENTS.delete(newCacheKey)
      ]);

      console.log(`KV hash for event ${event.id} deleted successfully.`);
      return; // Skip further processing for this event
    }

    // Construct minimal event data for hashing
    const minimalEventData = {
      id: event.id,
      name: event.name,
      starts_on: event.starts_on,
      slug: event.slug,
    };

    // Compute event hash and compare with stored hash
    const eventHash = crypto.createHash('sha256').update(JSON.stringify(minimalEventData)).digest('hex');
    const cacheKey = `${cachePrefix}${event.id}`;
    const newCacheKey = `${cacheKey}_v2`; // assuming hashVersion is defined globally

    const storedOldHash = await env.KP_EVENTS.get(cacheKey);
    const storedNewHash = await env.KP_EVENTS.get(newCacheKey);

    // If event data has changed, update database and KV
    if (eventHash !== storedOldHash && eventHash !== storedNewHash) {
      console.log(`Event ${event.id} has changed. Processing...`);
      // Handle image changes
      let imagePublicURL = null;
      const existingEvent = await supabase.from('events').select('original_image_url, supabase_image_banner').eq('id', event.id).single();
      console.log(existingEvent)
      console.log(event.image_banner)
      console.log(event)
      if (!existingEvent.data || existingEvent.data?.original_image_url !== event.image_banner) {
        if (existingEvent.data && existingEvent.data?.supabase_image_banner) {
          await supabase.storage.from('images').remove([existingEvent.data.supabase_image_banner]);
        }
	console.log(event.image_banner)
        const imageResponse = await fetch(event.image_banner);
        const imageBlob = await imageResponse.blob();
        const imageName = `${event.id}.png`;
        const { data: storageData, error: storageError } = await supabase.storage
          .from('images')
          .upload(imageName, imageBlob, {
            contentType: imageBlob.type,
            cacheControl: '3600',
            upsert: true
          });

        if (storageError) {
          throw new Error('Error uploading image: ' + storageError.message);
        }

        imagePublicURL = (await supabase.storage.from('images').getPublicUrl(imageName)).data.publicUrl;
	console.log('Image Public URL:')
	console.log(imagePublicURL)
      }
      console.log('Existing Event image: ')
      console.log(exisistingEvent.data?.supabase_image_banner)
      // Upsert event data
      const eventData = {
        id: event.id,
        name: event.name,
        starts_on: event.starts_on,
        supabase_image_banner: imagePublicURL || existingEvent.data?.supabase_image_banner,
        slug: event.slug,
        original_image_url: event.image_banner
      };

      const { error: dbError } = await supabase.from('events').upsert([eventData], { onConflict: ['id'] });

      if (dbError) {
        throw new Error('Error inserting/updating data: ' + dbError.message);
      }

      // Update event hash in KV
      await env.KP_EVENTS.put(newCacheKey, eventHash);
      console.log(`Event ${event.id} processed successfully.`);
    } else {
      console.log(`Event ${event.id} has not changed. Skipping...`);
    }
  }));
}










