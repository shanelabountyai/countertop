// The time bans from CLAUDE.md ("Time rules"), carried over from the Bookable
// build where each one had already cost a defect. Every one of these reads or
// writes a calendar value through the PROCESS timezone, which on this project
// is never the answer — the restaurant's timezone is a config value, and the
// daily order-number reset and every report bucket derive from it.
export const noTimeAxisRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date'][arguments.length>0]",
      message: 'new Date(string) parses through the process timezone. Convert in the restaurant-timezone module, not here.',
    },
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='parse']",
      message: 'Date.parse parses through the process timezone. Convert in the restaurant-timezone module, not here.',
    },
    {
      selector: "CallExpression[callee.property.name=/^(get|set)(Hours|Minutes|Seconds|Milliseconds|Date|Month|FullYear|Day)$/]",
      message: 'Date get/set accessors read/write through the process timezone. Bucket by the restaurant timezone instead.',
    },
    {
      selector: "CallExpression[callee.property.name='getTimezoneOffset']",
      message: 'getTimezoneOffset reads the process timezone directly.',
    },
    {
      selector: "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString']",
      message: "toISOString().slice(0,10) derives a calendar day from an instant through UTC. The business day is a restaurant-timezone question.",
    },
  ],
};

// packages/core is pure: the engine takes `now` as a parameter (CLAUDE.md).
// A module that reads the clock itself cannot be tested at a frozen instant,
// which is how "works until 11:59pm" ships.
export const noClockReadRules = {
  'no-restricted-syntax': [
    'error',
    ...noTimeAxisRules['no-restricted-syntax'].slice(1),
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: 'packages/core never reads the system clock — take `now` as a parameter.',
    },
    {
      selector: "NewExpression[callee.name='Date']",
      message: 'packages/core never reads the system clock — take `now` as a parameter.',
    },
  ],
};
