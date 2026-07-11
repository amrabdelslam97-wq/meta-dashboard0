/**
 * Creative Profile Engine — Phase 21 Section 1-2
 *
 * Build complete creative profile and extract all creative assets.
 * No simulation. Only Meta data. Mathematical calculations only when needed.
 */

const db = require('../db/database');

// Creative type classifications (from Meta API)
const CREATIVE_TYPES = {
  IMAGE: 'Image',
  VIDEO: 'Video',
  CAROUSEL: 'Carousel',
  SLIDESHOW: 'Slideshow',
  COLLECTION: 'Collection',
  DYNAMIC: 'Dynamic Creative',
  INSTANT_EXPERIENCE: 'Instant Experience',
  CATALOG: 'Catalog',
};

const CTA_TYPES = {
  LEARN_MORE: 'Learn More',
  SHOP_NOW: 'Shop Now',
  BOOK_NOW: 'Book Now',
  GET_OFFER: 'Get Offer',
  SIGN_UP: 'Sign Up',
  DOWNLOAD: 'Download',
  CONTACT_US: 'Contact Us',
  MESSAGE: 'Send Message',
  CALL_NOW: 'Call Now',
  SUBSCRIBE: 'Subscribe',
};

/**
 * Get complete creative profile for a single ad.
 * Combines metadata from ads table + creative_analytics table + insights data.
 */
function getCreativeProfile(metaAdId) {
  // Get ad metadata
  const ad = db.get(
    `SELECT a.*, c.meta_campaign_id, c.objective, s.meta_adset_id
     FROM ads a
     LEFT JOIN campaigns c ON c.id = a.campaign_id
     LEFT JOIN ad_sets s ON s.id = a.ad_set_id
     WHERE a.meta_ad_id = ?`,
    [metaAdId]
  );

  if (!ad) {
    return {
      error: 'Creative not found',
      meta_ad_id: metaAdId,
    };
  }

  // Get creative analytics (performance history)
  const analytics = db.get(
    `SELECT * FROM creative_analytics
     WHERE meta_ad_id = ?
     ORDER BY date_until DESC LIMIT 1`,
    [metaAdId]
  );

  // Parse creative JSON if available
  let creative = null;
  let assets = {};
  if (ad.creative_json) {
    try {
      creative = JSON.parse(ad.creative_json);
      assets = extractCreativeAssets(creative);
    } catch (e) {
      creative = null;
    }
  }

  return {
    profile: {
      meta_ad_id: metaAdId,
      name: ad.name,
      status: ad.status,
      effective_status: ad.effective_status,
      created_at: ad.created_at,
      updated_at: ad.updated_at,
      campaign: {
        meta_campaign_id: ad.meta_campaign_id,
        objective: ad.objective,
      },
      ad_set: {
        meta_adset_id: ad.meta_adset_id,
      },
      destination_type: ad.destination_type || 'WEBSITE',
    },
    assets: assets,
    performance: analytics ? {
      spend: analytics.spend,
      impressions: analytics.impressions,
      clicks: analytics.clicks,
      results: analytics.results,
      ctr: analytics.ctr,
      cpm: analytics.cpm,
      cpa: analytics.cpa,
      roas: analytics.roas,
      frequency: analytics.frequency,
    } : null,
    raw_creative: creative,
  };
}

/**
 * Extract creative assets from Meta creative object.
 * Handles: headline, primary_text, description, CTA, URLs, images, videos, etc.
 */
function extractCreativeAssets(creative) {
  if (!creative) return {};

  const assets = {};

  // Object Story Spec extraction (most common)
  if (creative.object_story_spec) {
    const oss = creative.object_story_spec;

    // Link data (image + headline + description)
    if (oss.link_data) {
      const linkData = oss.link_data;
      assets.headline = linkData.headline || null;
      assets.description = linkData.description || null;
      assets.image_url = linkData.picture || null;
      assets.url = linkData.link || null;
      assets.cta_type = linkData.call_to_action?.type || null;
    }

    // Video data
    if (oss.video_data) {
      const videoData = oss.video_data;
      assets.video_url = videoData.video_id ? `https://video.facebook.com/${videoData.video_id}` : null;
      assets.video_thumbnail = videoData.thumbnail_url || null;
      assets.video_title = videoData.title || null;
      assets.video_description = videoData.description || null;
    }

    // Message data (for messaging campaigns)
    if (oss.message) {
      assets.messaging_text = oss.message;
    }
  }

  // Primary Text (standalone text)
  if (creative.adlabels) {
    assets.ad_labels = creative.adlabels;
  }

  // Detect creative type from structure
  if (creative.object_story_spec?.video_data) {
    assets.creative_type = 'Video';
  } else if (creative.object_story_spec?.carousel_data) {
    assets.creative_type = 'Carousel';
  } else if (creative.object_story_spec?.link_data?.picture) {
    assets.creative_type = 'Image';
  } else {
    assets.creative_type = 'Unknown';
  }

  return assets;
}

/**
 * Get creative assets display-ready format.
 */
function getCreativeAssets(metaAdId) {
  const profile = getCreativeProfile(metaAdId);

  if (profile.error) {
    return { error: profile.error };
  }

  return {
    creative_id: profile.profile.meta_ad_id,
    creative_name: profile.profile.name,
    creative_type: profile.assets.creative_type || 'Unknown',
    headline: profile.assets.headline || null,
    description: profile.assets.description || null,
    cta_type: profile.assets.cta_type ? CTA_TYPES[profile.assets.cta_type] || profile.assets.cta_type : null,
    destination_url: profile.assets.url || null,
    image_url: profile.assets.image_url || null,
    video_url: profile.assets.video_url || null,
    thumbnail_url: profile.assets.video_thumbnail || null,
    messaging_text: profile.assets.messaging_text || null,
    campaign_objective: profile.profile.campaign.objective,
    destination_type: profile.profile.destination_type,
  };
}

/**
 * List all creatives for a campaign with basic info.
 */
function listCreativesByCampaign(metaCampaignId, limit = 50) {
  const rows = db.all(
    `SELECT a.meta_ad_id, a.name, a.status, a.created_at, ca.spend, ca.results, ca.ctr, ca.cpa, ca.roas, ca.score_overall
     FROM ads a
     LEFT JOIN creative_analytics ca ON ca.meta_ad_id = a.meta_ad_id AND ca.date_until = (
       SELECT MAX(date_until) FROM creative_analytics WHERE meta_ad_id = a.meta_ad_id
     )
     WHERE a.campaign_id = (SELECT id FROM campaigns WHERE meta_campaign_id = ?)
     ORDER BY ca.spend DESC
     LIMIT ?`,
    [metaCampaignId, limit]
  );

  return {
    campaign: metaCampaignId,
    total_creatives: rows.length,
    creatives: rows.map(r => ({
      meta_ad_id: r.meta_ad_id,
      name: r.name,
      status: r.status,
      created_at: r.created_at,
      spend: r.spend,
      results: r.results,
      ctr: r.ctr,
      cpa: r.cpa,
      roas: r.roas,
      score: r.score_overall,
    })),
  };
}

module.exports = {
  getCreativeProfile,
  extractCreativeAssets,
  getCreativeAssets,
  listCreativesByCampaign,
  CREATIVE_TYPES,
  CTA_TYPES,
};
