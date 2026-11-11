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
    // GTM container GTM-NPFX54H8 is installed directly in each page's <head> (and <noscript> after <body>).
    // Keep this empty, or the container would load twice.
    gtmId: '',
    metaPixelId: '',        // e.g. '123456789012345'
    googleAds: {
      id: '',               // e.g. 'AW-123456789'. Leave empty if Google Ads conversions run through GTM.
      conversions: {        // conversion labels, e.g. Lead: 'AbCdEfGhIj'
        Lead: '',                // individual: fires when step 1 (name, email, phone) is saved
        SubmitApplication: '',   // individual: fires when the whole application is sent
        CompleteRegistration: '',// fires on the qualified page
        Schedule: ''             // fires when a call is booked
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
      videoSrc: 'https://youtu.be/1UnC8iKCVv8',
      videoPoster: 'https://i.ytimg.com/vi/1UnC8iKCVv8/hqdefault.jpg',

      // Curriculum PDF. When set, a "Download the curriculum" link appears under the curriculum section.
      // Leave empty until the real document exists, e.g. '/assets/docs/gtme-curriculum.pdf'.
      curriculumUrl: '',

      // Call booking for qualified applicants, shown on /apply/qualified.
      // A Cal.com link or a Calendly link both work.
      bookingUrl: 'https://cal.com/shrinishkarsh/gtme-school',
      // Cal.com embed namespace. Defaults to the event slug from bookingUrl ('gtme-school').
      bookingNamespace: 'gtme-school',
      calendlyUrl: '', // older setting, still read if bookingUrl is empty

      // Where each applicant goes after the multi-step form.
      routes: {
        qualified: '/apply/qualified',   // calendar embedded straight away
        notQualified: '/apply/not-a-fit', // offer the recorded course instead
        booked: '/apply/booked'          // thank-you + what to prepare, after the call is booked
      },

      // The recorded course offered to applicants who aren't ready for the program.
      downsell: {
        url: '',                 // checkout or landing page for the recorded course, e.g. 'https://gtme.school/course'
        price: '₹999',
        name: 'The GTM Engineering Starter Course'
      },

      // Short "what to prepare" video on the booked page (optional). .mp4 or YouTube / Vimeo / Loom link.
      prepVideoSrc: '',

      // Qualification: applicants matching ANY rule are not qualified and go to routes.notQualified.
      // Default (from the VSL architecture doc): qualified = ready to invest the $4,000, with or without a payment plan.
      qualification: {
        disqualifyIf: [
          { field: 'invest', in: ['Not right now'] }
          // , { field: 'hours_ok', in: ['No'] }   // uncomment to also route people without 6–10 hours a week
        ]
      },
      askInvestment: false,
      investmentOptions: []
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
  // automatically; while a list is empty, nothing is shown (no placeholder cards on the page).
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
