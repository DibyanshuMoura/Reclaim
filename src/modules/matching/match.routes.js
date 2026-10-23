'use strict';

/**
 * Match routes. Handlers stay thin — access is granted ONLY through either
 * party's unguessable match token; the scoped view contains no counterparty
 * contact details until both parties confirmed (AGENT.md §2, §10).
 */
const { Router } = require('express');
const matchService = require('./match.service');
const { ApiError } = require('../../utils/errors');

function createMatchRouter() {
  const router = Router();

  function requireValidToken(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw ApiError.notFound('Match not found');
    }
    return rawToken;
  }

  router.get('/private/matches/:token', async (req, res) => {
    const match = await matchService.getMatchViewByToken(requireValidToken(req.params.token));
    res.status(200).json({ match });
  });

  router.post('/private/matches/:token/confirm', async (req, res) => {
    const match = await matchService.confirmMatchByToken(requireValidToken(req.params.token));
    res.status(200).json({ match });
  });

  router.post('/private/matches/:token/reject', async (req, res) => {
    const match = await matchService.rejectMatchByToken(requireValidToken(req.params.token));
    res.status(200).json({ match });
  });

  return router;
}

module.exports = { createMatchRouter };
