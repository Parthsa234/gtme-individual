/*
 * GTME.School VSL — site configuration.
 *
 * Everything the campaign owner needs to change lives here. Nothing in this file is secret:
 * Pixel / GTM / Google Ads IDs and Calendly links are public by design. The application
 * webhook URL is NOT here — it lives in the APPLY_WEBHOOK_URL environment variable on Vercel
 * and is only read by /api/apply.
 *
 * Empty strings mean "not configured yet". The page detects that and shows a labelled
 * placeholder (video, Calendly) or simply skips loading the script (tracking).
 */
window.GTME_CONFIG = {
  // Logs every tracking event to the console and to window.__gtmeEvents. Also on with ?debug=1.
  debug: false,

  tracking: {
    gtmId: '',              // e.g. 'GTM-XXXXXXX'
    metaPixelId: '',        // e.g. '123456789012345'
    googleAds: {
      id: '',               // e.g. 'AW-123456789'. Leave empty if Google Ads conversions run through GTM.
      conversions: {        // conversion labels, e.g. Lead: 'AbCdEfGhIj'
        Lead: '',
        CompleteRegistration: '',
        Schedule: ''
      }
    }
  },

  // Where applications are POSTed. /api/apply is the Vercel function in /api/apply.js.
  formEndpoint: '/api/apply',
  // If the endpoint is unreachable or not configured, open a pre-filled email instead
  // (the same behaviour as the forms on gtme.school today). No Lead event fires in this case,
  // because the submission cannot be confirmed.
  mailtoFallback: 'hello@gtme.school',

  funnels: {
    /* ---------------- Individual VSL (/vsl) ---------------- */
    individual: {
      // VSL video. Either an .mp4 URL, or a YouTube / Vimeo / Wistia / Loom embed URL.
      videoSrc: '',
      videoPoster: '',
      // Calendly event URL for qualified applicants, e.g. 'https://calendly.com/gtme-school/discovery-call'
      calendlyUrl: '',

      // Qualification. Applicants that match ANY rule below are not offered the booking step.
      // Default rule comes from the program document: applicants must be able to commit 8–10 hours a week.
      qualification: {
        disqualifyIf: [
          { field: 'hours', in: ['Less than 5 hours', '5–8 hours'] }
        ]
      },
      // Investment / income question. Off until the business approves the wording and options.
      askInvestment: false,
      investmentOptions: ['Ready to invest in a program now', 'Would need to plan for it', 'Not able to invest right now']
    },

    /* ---------------- Corporate VSL (/corporate-vsl) ---------------- */
    corporate: {
      videoSrc: '',
      videoPoster: '',
      calendlyUrl: '',
      qualification: {
        disqualifyIf: [
          { field: 'team_size', in: ['Just me'] }
        ]
      },
      askInvestment: false,
      investmentOptions: []
    }
  },

  // Social proof that still has to be supplied by the team. Add items here and they render
  // automatically; while a list is empty, a clearly labelled placeholder card is shown instead.
  proof: {
    // { src: '/assets/img/student-1.jpg', alt: '...', caption: '...' }
    studentScreenshots: [],
    // { name: '...', role: '...', quote: '...', url: 'https://www.linkedin.com/...' }
    linkedinRecommendations: [],
    // { value: '42', label: 'calls booked by ... (verified, source: ...)' }
    verifiedStats: [],
    // Corporate page. { name: '...', role: 'VP Sales, Company', quote: '...', url: '' } — with written permission only.
    corporateTestimonials: []
  }
};
