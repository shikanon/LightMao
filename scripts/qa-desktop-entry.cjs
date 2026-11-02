const { app } = require('electron');
if (!process.env.LIGHTMAO_QA_PROFILE) throw new Error('An isolated QA profile is required');
app.setPath('userData', process.env.LIGHTMAO_QA_PROFILE);
require('../apps/desktop/main.cjs');
