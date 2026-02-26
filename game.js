// ═══════════════════════════════════════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════════════════════════════════════

const G = {
  // Solo game state
  editionId: null,
  deckKey: null,
  draw: [],
  discard: [],
  hand: [],
  staged: [],
  intermediate: [],
  selected: [],
  selectMode: false,
  intermediateSelected: [],
  intermediateSelectMode: false,
  hp: {},
  specialDeck: [],
  specialDiscard: [],
  specialCurrent: null,
  specialMode: null,
  
  // Multiplayer state
  isMultiplayer: false,
  roomCode: null,
  playerId: null,
  playerName: null,
  isHost: false,
  lastSeenRevealTimestamp: 0,
  
  // New multiplayer features
  turnOrder: [], // Array of player IDs in turn order
  currentTurn: 0, // Index in turnOrder
  gameStarted: false,
  combat: null // { attacker, defender, attackerCards, defenderCards, attackerReady, defenderReady, revealed }
};

// Cards currently playing their exit animation (uid -> card)
const _exitingCards = new Map();

// UID of the last card chosen via Pick Random (for log prefix)
let _randomPickedUid = null;

// State for deck/hand inspect flows
let _inspectState = { source: 'own', pid: null, cards: [], assignments: {}, deckSortOrder: [] };
let _pendingDeckShare = null; // { requesterId, requesterName, count }
let _pendingHandShare = null; // { requesterId, requesterName }

function scheduleCardExit(card) {
  _exitingCards.set(card.uid, { image: card.image, uid: card.uid });
  setTimeout(() => {
    _exitingCards.delete(card.uid);
    renderHand();
  }, 320);
}

// ═══════════════════════════════════════════════════════════════════════
// MULTIPLAYER - LOCAL STORAGE SYNC
// ═══════════════════════════════════════════════════════════════════════

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substr(2, 9) + Date.now();
}

function getRoomKey() {
  return 'room_' + G.roomCode;
}

// Firebase room data cache
let firebaseRoomCache = null;
let firebaseListener = null;
let firebaseReady = false;

// Normalize combat: Firebase drops empty arrays/objects, so ensure structure
function normalizeCombat(combat) {
  if (!combat) return null;
  // New shared combat zone format: { [playerId]: { cards: [], revealed: false } }
  // Clean out any old attacker/defender keys
  const clean = {};
  for (const key of Object.keys(combat)) {
    if (key.startsWith('p_')) {
      const entry = combat[key];
      clean[key] = {
        cards: entry.cards || [],
        revealed: entry.revealed || false
      };
    }
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

function getRoomData() {
  // Return cached data - will be updated by real-time listener
  return firebaseRoomCache;
}

function setRoomData(data) {
  if (!G.roomCode) {
    console.error('❌ setRoomData: No room code set');
    return;
  }
  
  if (!window.fbDatabase) {
    console.error('❌ setRoomData: Firebase not initialized - window.fbDatabase is null/undefined');
    console.log('window.fbDatabase:', window.fbDatabase);
    console.log('typeof firebase:', typeof firebase);
    console.log('firebase.apps:', firebase?.apps);
    return;
  }
  
  try {
    console.log('📝 Writing room data to Firebase for room:', G.roomCode);
    console.log('Data being written:', JSON.stringify(data).substring(0, 200) + '...');
    
    const roomRef = window.fbDatabase.ref('rooms/' + G.roomCode);
    roomRef.set(data, (error) => {
      if (error) {
        console.error('❌ Error writing room data:', error.code, error.message);
      } else {
        console.log('✅ Room data successfully written to Firebase:', G.roomCode);
        firebaseRoomCache = data;
      }
    });
  } catch (e) {
    console.error('❌ Exception in setRoomData:', e);
  }
}

// Set up real-time listener for room data changes
function setupFirebaseListener() {
  if (!G.roomCode) {
    console.error('No room code set');
    return new Promise((resolve) => resolve(false));
  }
  
  console.log('Attempting to set up Firebase listener for room:', G.roomCode);
  console.log('window.fbDatabase exists?', !!window.fbDatabase);
  
  // Wait for Firebase to be ready
  return new Promise((resolve) => {
    let resolved = false;
    let checkAttempts = 0;
    
    const checkFirebase = setInterval(() => {
      checkAttempts++;
      console.log('Firebase check attempt:', checkAttempts, 'fbDatabase ready?', !!window.fbDatabase);
      
      if (window.fbDatabase) {
        clearInterval(checkFirebase);
        console.log('Firebase is ready, setting up listener');
        
        // Remove old listener if exists
        if (firebaseListener) {
          try {
            window.fbDatabase.ref('rooms/' + G.roomCode).off();
          } catch (e) {
            console.error('Error removing old listener:', e);
          }
          firebaseListener = null;
          firebaseReady = false;
        }
        
        const roomRef = window.fbDatabase.ref('rooms/' + G.roomCode);
        let timeoutHandle = null;
        
        // Set timeout for response
        timeoutHandle = setTimeout(() => {
          if (!resolved) {
            console.error('❌ Firebase listener timeout - no data within 6 seconds for room:', G.roomCode);
            resolved = true;
            roomRef.off();
            resolve(false);
          }
        }, 6000);
        
        // Set up the listener
        firebaseListener = roomRef.on('value', (snapshot) => {
          const data = snapshot.val();
          console.log('🔔 Firebase listener callback fired for room:', G.roomCode);
          console.log('Data exists?', data !== null);
          if (data) {
            console.log('Data keys:', Object.keys(data));
            // Always update cache with new data
            firebaseRoomCache = data;
            
            // Trigger sync if on lobby or play screen
            if (cur === 's-lobby-host' || cur === 's-lobby-guest' || cur === 's-play') {
              syncFromRoom();
            }
          }
          
          if (data !== null && !resolved) {
            console.log('✅ Room data found! Resolving promise');
            resolved = true;
            clearTimeout(timeoutHandle);
            firebaseReady = true;
            resolve(true);
          }
        }, (error) => {
          console.error('❌ Firebase listener error:', error?.code, error?.message);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutHandle);
            resolve(false);
          }
        });
      } else if (checkAttempts > 30) {
        // Tried 30 times (3 seconds) - Firebase not loading
        clearInterval(checkFirebase);
        console.error('Firebase failed to initialize after 3 seconds');
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }
    }, 100);
  });
}

function removeFirebaseListener() {
  if (window.fbDatabase && G.roomCode) {
    try {
      window.fbDatabase.ref('rooms/' + G.roomCode).off();
      firebaseListener = null;
      firebaseReady = false;
      console.log('Firebase listener removed for room:', G.roomCode);
    } catch (e) {
      console.error('Error removing Firebase listener:', e);
    }
  }
}

function updateMyPlayer() {
  if (!G.isMultiplayer || !G.roomCode) return;
  
  const roomData = getRoomData();
  if (!roomData) return;
  
  if (!roomData.players) roomData.players = {};
  
  roomData.players[G.playerId] = {
    name: G.playerName,
    deckKey: G.deckKey,
    hp: G.hp,
    cardCounts: {
      draw: G.draw.length,
      hand: G.hand.length,
      staged: G.staged.length,
      intermediate: G.intermediate.length,
      discard: G.discard.length
    },
    discardCards: G.discard.map(c => ({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey })), // Copy of discard pile with origin deck
    specialCurrent: G.specialCurrent || null, // Current active special ability card
    lastUpdate: Date.now()
  };
  
  setRoomData(roomData);
}

function publishReveal(cards) {
  if (!G.isMultiplayer || !G.roomCode) return;
  
  const roomData = getRoomData();
  if (!roomData) return;
  
  if (!roomData.reveals) roomData.reveals = [];
  
  roomData.reveals.push({
    playerId: G.playerId,
    playerName: G.playerName,
    cards: cards.map(c => ({ image: c.image })),
    action: 'played',
    timestamp: Date.now()
  });
  
  // Keep only last 20 reveals
  if (roomData.reveals.length > 20) {
    roomData.reveals = roomData.reveals.slice(-20);
  }
  
  setRoomData(roomData);
}

// Publish a play or discard action for a single card
function publishAction(card, action) {
  if (!G.isMultiplayer || !G.roomCode) return;
  
  const roomData = getRoomData();
  if (!roomData) return;
  
  if (!roomData.reveals) roomData.reveals = [];
  
  roomData.reveals.push({
    playerId: G.playerId,
    playerName: G.playerName,
    cards: [{ image: card.image }],
    action: action, // 'played' or 'discarded'
    timestamp: Date.now()
  });
  
  if (roomData.reveals.length > 20) {
    roomData.reveals = roomData.reveals.slice(-20);
  }
  
  setRoomData(roomData);
}

// Generic event publisher — broadcasts any game action to all players via Firebase reveals
function publishEvent(payload) {
  if (!G.isMultiplayer || !G.roomCode) return;
  const roomData = getRoomData();
  if (!roomData) return;
  if (!roomData.reveals) roomData.reveals = [];
  roomData.reveals.push(Object.assign({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now() }, payload));
  if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
  setRoomData(roomData);
}

// Play a card: discard it (or intermediate) + notify others
function playCard(card) {
  const dk = DECKS[G.deckKey];
  scheduleCardExit(card);
  const rndPrefixPlay = (card.uid === _randomPickedUid) ? '🎲 Random: ' : '';
  if (rndPrefixPlay) _randomPickedUid = null;
  addLogEntry(rndPrefixPlay + 'You played: ' + cardLabel(card), 'play');
  G.hand = G.hand.filter(c => c.uid !== card.uid);
  G.staged = G.staged.filter(c => c.uid !== card.uid);

  if (dk.intermediateZone && dk.intermediateZone.enabled) {
    G.intermediate.push(card);
  } else {
    G.discard.push(card);
    if (G.isMultiplayer) {
      const roomData = getRoomData();
      if (roomData && roomData.players[G.playerId]) {
        if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
        roomData.players[G.playerId].discardCards.push({ image: card.image, uid: card.uid });
        setRoomData(roomData);
      }
    }
  }

  if (G.isMultiplayer) {
    if (rndPrefixPlay) {
      publishEvent({ action: 'played', cards: [{ image: card.image }], random: true });
    } else {
      publishAction(card, 'played');
    }
  }
  syncTS();
  updateAll();
  closeCardOverlay();
  toast('Played');
}

// Play selected cards (from select mode)
function playSelected() {
  if (!G.selected.length) { toast('Select at least one card'); return; }
  const dk = DECKS[G.deckKey];
  const cards = G.hand.filter(c => G.selected.includes(c.uid));
  cards.forEach(c => scheduleCardExit(c));
  if (cards.length > 0) addLogEntry('You played ' + cards.length + ' card' + (cards.length > 1 ? 's' : ''), 'play');
  cards.forEach(c => {
    G.hand = G.hand.filter(x => x.uid !== c.uid);
    G.staged = G.staged.filter(x => x.uid !== c.uid);
    if (dk.intermediateZone && dk.intermediateZone.enabled) {
      G.intermediate.push(c);
    } else {
      G.discard.push(c);
      if (G.isMultiplayer) {
        const roomData = getRoomData();
        if (roomData && roomData.players[G.playerId]) {
          if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
          roomData.players[G.playerId].discardCards.push({ image: c.image, uid: c.uid });
          setRoomData(roomData);
        }
      }
    }
  });
  if (G.isMultiplayer && cards.length > 0) publishReveal(cards);
  exitSel();
  updateAll();
  toast(cards.length + ' card' + (cards.length > 1 ? 's' : '') + ' played');
}

// Update host name in room data
function updateHostName(name) {
  G.playerName = name.trim() || 'Host';
  const roomData = getRoomData();
  if (roomData && roomData.players[G.playerId]) {
    roomData.players[G.playerId].name = G.playerName;
    setRoomData(roomData);
  }
}

// BroadcastChannel for real-time sync
let broadcastChannel = null;

function initBroadcastChannel() {
  if (typeof BroadcastChannel === 'undefined') {
    console.log('BroadcastChannel not supported, using polling');
    return;
  }
  
  try {
    broadcastChannel = new BroadcastChannel('deck_game_room_' + G.roomCode);
    broadcastChannel.onmessage = (event) => {
      if (event.data.type === 'update') {
        syncFromRoom();
      }
    };
  } catch (e) {
    console.error('BroadcastChannel error:', e);
  }
}

function broadcastUpdate() {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage({ type: 'update' });
    } catch (e) {
      console.error('Broadcast error:', e);
    }
  }
}

function syncFromRoom() {
  if (!G.isMultiplayer) return;
  
  const roomData = getRoomData();
  if (!roomData) return;
  
  // Sync game state
  G.turnOrder = roomData.turnOrder || [];
  G.currentTurn = roomData.currentTurn || 0;
  G.gameStarted = roomData.gameStarted || false;
  G.combat = roomData.combat ? normalizeCombat(roomData.combat) : null;
  
  // Reconcile local discard with server truth
  // (another player may have taken a card from our discard pile)
  if (roomData.players && roomData.players[G.playerId]) {
    const serverDiscard = roomData.players[G.playerId].discardCards || [];
    const serverUids = new Set(serverDiscard.map(c => c.uid));
    const localLen = G.discard.length;
    G.discard = G.discard.filter(c => serverUids.has(c.uid));
    if (G.discard.length !== localLen) {
      // Cards were removed by another player, update UI
      updateAll();
    }
  }
  
  // Update lobby lists
  if (cur === 's-lobby-host' || cur === 's-lobby-guest') {
    renderLobbyPlayers();
  }
  
  // Update player status area and combat during gameplay
  if (cur === 's-play') {
    renderPlayerStatusArea();
    renderDiscardBrowsing();
    renderCombatArea();
  }
  
  // Update other players view
  if (document.getElementById('sh-other-players').classList.contains('open')) {
    buildOtherPlayersList();
  }
  
  // Check for new reveals
  checkNewReveals(roomData);
}

function checkNewReveals(roomData) {
  if (!roomData.reveals || roomData.reveals.length === 0) return;

  const newReveals = roomData.reveals.filter(r =>
    r.timestamp > G.lastSeenRevealTimestamp && r.playerId !== G.playerId
  );

  if (newReveals.length === 0) return;

  G.lastSeenRevealTimestamp = newReveals[newReveals.length - 1].timestamp;

  let lastShowNotif = null;

  newReveals.forEach(function(r) {
    const n = r.playerName || 'Someone';
    const cnt = r.cards ? r.cards.length : (r.count || 1);
    const cWord = cnt === 1 ? '1 card' : cnt + ' cards';
    let text, type;

    switch (r.action) {
      case 'played':
        text = r.random ? n + ' played a random card 🎲' : n + ' played ' + cWord;
        type = 'other';
        lastShowNotif = r; // always show popup; showRevealNotification handles random
        break;
      case 'discarded':
        text = r.random ? n + ' discarded a random card 🎲' : n + ' discarded ' + cWord;
        type = 'discard';
        lastShowNotif = r;
        break;
      case 'drew':
        text = n + ' drew ' + cWord;
        type = 'draw';
        break;
      case 'hp-change':
        var dir = (r.delta > 0) ? 'increased' : 'decreased';
        text = n + ' ' + dir + ' ' + r.barLabel + ': ' + r.from + ' \u2192 ' + r.to + ' HP';
        type = 'hp';
        break;
      case 'added-to-combat':
        text = r.random
          ? n + ' added a random card from hand to combat \uD83C\uDFB2\u2694\uFE0F'
          : r.fromTopDeck
            ? n + ' added the top card of their deck to combat \u2694\uFE0F'
            : r.fromHand
              ? n + ' added ' + cWord + ' from hand to combat \u2694\uFE0F'
              : n + ' added ' + cWord + ' to combat \u2694\uFE0F';
        type = 'combat';
        break;
      case 'combat-reveal':
        text = n + ' revealed their combat cards \ud83d\udd13';
        type = 'combat';
        break;
      case 'combat-cleared':
        text = n + ' cleared the combat zone \ud83d\uddd1\ufe0f';
        type = 'combat';
        break;
      case 'returned-to-deck':
        var posLabel = r.pos === 'top' ? 'top of deck' : r.pos === 'bottom' ? 'bottom of deck' : 'shuffled into deck';
        text = n + ' returned ' + cWord + ' to ' + posLabel;
        type = 'other';
        break;
      case 'took-from-discard':
        text = n + ' took \u201c' + (r.cardName || 'a card') + '\u201d from ' + (r.fromName || 'someone') + "'s discard";
        type = 'other';
        break;
      case 'took-from-own-discard':
        text = n + ' recovered \u201c' + (r.cardName || 'a card') + '\u201d from their own discard';
        type = 'other';
        break;
      case 'moved-zone-to-hand':
        text = n + ' moved \u201c' + (r.cardName || 'a card') + '\u201d \u2192 hand';
        type = 'other';
        break;
      case 'moved-zone-to-discard':
        text = n + ' moved \u201c' + (r.cardName || 'a card') + '\u201d \u2192 discard';
        type = 'discard';
        break;
      case 'shuffled-hand-in':
        text = n + ' shuffled hand (' + (r.count || '?') + ' cards) into deck';
        type = 'other';
        break;
      case 'shuffled-discard-in':
        text = n + ' shuffled discard (' + (r.count || '?') + ' cards) into deck';
        type = 'other';
        break;
      case 'used-special':
        text = n + ' used ' + (r.saLabel || 'special ability') + (r.cardName ? ': ' + r.cardName : '');
        type = 'other';
        break;
      case 'activated-special':
        text = n + (r.random ? ' randomly activated their special ability 🎲✨' : ' activated their special ability ✨');
        type = 'play';
        lastShowNotif = r;
        break;
      case 'turn-end':
        text = n + ' ended their turn';
        type = 'turn';
        break;
      case 'force-discard-hand':
        if (r.victimId === G.playerId) {
          G.hand = G.hand.filter(c => c.uid !== r.cardUid);
          if (r.cardImage) G.discard.push({ image: r.cardImage, uid: r.cardUid, deckKey: r.cardDeckKey || G.deckKey });
          syncMyDiscard(); syncMyHand(); updateAll();
        }
        text = r.victimId === G.playerId
          ? r.playerName + ' forced you to discard "' + (r.cardName || 'a card') + '"'
          : n + ' made ' + (r.victimName || 'someone') + ' discard "' + (r.cardName || 'a card') + '"';
        type = 'other';
        break;
      case 'force-shuffle-to-deck':
        if (r.victimId === G.playerId) {
          G.hand = G.hand.filter(c => c.uid !== r.cardUid);
          if (r.cardImage) { G.draw.push({ image: r.cardImage, uid: r.cardUid, deckKey: r.cardDeckKey || G.deckKey }); G.draw = shuffle(G.draw); }
          syncMyHand(); updateAll();
        }
        text = r.victimId === G.playerId
          ? r.playerName + ' shuffled "' + (r.cardName || 'a card') + '" from your hand into your deck'
          : n + ' shuffled "' + (r.cardName || 'a card') + '" from ' + (r.victimName || 'someone') + "'s hand into their deck";
        type = 'other';
        break;
      case 'deck-share-request':
        if (r.victimId === G.playerId) {
          _pendingDeckShare = { requesterId: r.playerId, requesterName: r.playerName, count: r.count };
          const dsText = document.getElementById('deck-share-text');
          if (dsText) dsText.textContent = r.playerName + ' wants to see your top ' + r.count + ' cards';
          const dsNotif = document.getElementById('deck-share-notif');
          if (dsNotif) { dsNotif.style.display = 'block'; setTimeout(() => dsNotif.style.display = 'none', 15000); }
        }
        text = n + ' is peeking at ' + (r.victimName || 'someone') + "'s top " + r.count + ' cards';
        type = 'other';
        break;
      case 'deck-share-response':
        if (r.requesterId === G.playerId) {
          _inspectState = { source: 'opp', pid: r.responderId, cards: (r.topCards || []).map((c, i) => ({ ...c, pos: i + 1 })), assignments: {}, deckSortOrder: (r.topCards || []).map(c => c.uid) };
          _inspectState.cards.forEach(c => { _inspectState.assignments[c.uid] = 'keep'; });
          buildOppTopNBrowseSheet(r.victimName || r.playerName || 'Opponent');
          openSheet('sh-inspect-top-n');
        }
        text = n + ' shared their top ' + (r.count || '?') + ' cards';
        type = 'other';
        break;
      case 'force-deck-peek-discard':
        if (r.victimId === G.playerId) {
          G.draw = G.draw.filter(c => c.uid !== r.cardUid);
          updateAll();
        }
        text = r.victimId === G.playerId
          ? n + ' discarded "' + (r.cardName || 'a card') + '" from your deck'
          : n + ' discarded "' + (r.cardName || 'a card') + '" from ' + (r.victimName || 'someone') + "'s deck";
        type = 'discard';
        break;
      case 'force-deck-peek-reorder':
        if (r.victimId === G.playerId && r.orderedUids) {
          const topN = r.orderedUids.map(uid => G.draw.find(c => c.uid === uid)).filter(Boolean);
          const rest = G.draw.filter(c => !r.orderedUids.includes(c.uid));
          G.draw = [...topN, ...rest];
          updateAll();
        }
        text = n + ' reordered the top of ' + (r.victimName || 'someone') + "'s deck";
        type = 'other';
        break;
      case 'force-deck-take-to-hand':
        if (r.victimId === G.playerId) {
          G.draw = G.draw.filter(c => c.uid !== r.cardUid);
          updateAll();
        }
        text = r.victimId === G.playerId
          ? n + ' took \u201c' + (r.cardName || 'a card') + '\u201d from your deck'
          : n + ' took \u201c' + (r.cardName || 'a card') + '\u201d from ' + (r.victimName || 'someone') + "'s deck to their hand";
        type = 'other';
        break;
      case 'force-take-from-hand':
        if (r.victimId === G.playerId) {
          G.hand = G.hand.filter(c => c.uid !== r.cardUid);
          syncMyHand();
          updateAll();
        }
        text = r.victimId === G.playerId
          ? n + ' took \u201c' + (r.cardName || 'a card') + '\u201d from your hand'
          : n + ' took \u201c' + (r.cardName || 'a card') + '\u201d from ' + (r.victimName || 'someone') + "'s hand";
        type = 'other';
        break;
      case 'peeked-deck':
        text = r.count === -1
          ? n + ' looked at their whole deck'
          : n + ' looked at their top ' + r.count + ' card' + (r.count === 1 ? '' : 's');
        type = 'other';
        break;
      case 'moved-in-deck':
        text = n + ' reordered cards in their deck';
        type = 'other';
        break;
      case 'drew-from-deck-position':
        text = n + ' took card #' + r.pos + ' from their deck to hand';
        type = 'other';
        break;
      case 'hand-share-request':
        if (r.victimId === G.playerId) {
          _pendingHandShare = { requesterId: r.playerId, requesterName: r.playerName };
          const hsText = document.getElementById('hand-share-text');
          if (hsText) hsText.textContent = r.playerName + ' wants to see your hand';
          const hsNotif = document.getElementById('hand-share-notif');
          if (hsNotif) { hsNotif.style.display = 'block'; setTimeout(() => hsNotif.style.display = 'none', 15000); }
        }
        text = n + ' wants to see ' + (r.victimName || 'someone') + "'s hand";
        type = 'other';
        break;
      case 'hand-share-response':
        if (r.requesterId === G.playerId) {
          buildOppHandViewSheet(r.victimName || r.playerName || 'Opponent', r.handCards || [], r.responderId);
          openSheet('sh-view-opp-hand');
        }
        text = n + ' shared their hand';
        type = 'other';
        break;
      default:
        text = n + ' performed an action';
        type = 'other';
    }

    if (text) addLogEntry(text, type);
  });

  // Show reveal notification only for the latest played/discarded event
  if (lastShowNotif && lastShowNotif.cards && lastShowNotif.cards.length > 0) {
    showRevealNotification(lastShowNotif);
  }
}

function showRevealNotification(reveal) {
  const notif = document.getElementById('reveal-notification');
  const action = reveal.action || 'played';
  const verb = action === 'discarded' ? 'discarded' : action === 'activated-special' ? 'activated their special ability' : 'played';
  const count = reveal.cards ? reveal.cards.length : 0;
  const cardWord = action === 'activated-special' ? '' : (reveal.random ? 'a random card \ud83c\udfb2' : (count === 1 ? 'a card' : count + ' cards'));
  document.getElementById('reveal-notif-player').textContent = reveal.playerName + ' ' + verb + (cardWord ? ' ' + cardWord : '') + '!';
  
  const timeAgo = Math.floor((Date.now() - reveal.timestamp) / 1000);
  document.getElementById('reveal-notif-time').textContent = timeAgo < 5 ? 'Just now' : timeAgo + 's ago';
  
  const grid = document.getElementById('reveal-notif-cards');
  grid.innerHTML = '';
  reveal.cards.forEach(card => {
    const div = document.createElement('div');
    div.className = 'reveal-card-item';
    div.innerHTML = `<img src="${card.image}" alt="">`;
    grid.appendChild(div);
  });
  
  notif.classList.add('show');
}

function closeRevealNotif() {
  document.getElementById('reveal-notification').classList.remove('show');
}

// Polling fallback (every 500ms for real-time feel)
let syncInterval = null;

function startSync() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(syncFromRoom, 500);
  console.log('✅ Sync started for room:', G.roomCode);
}

function stopSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (broadcastChannel) {
    broadcastChannel.close();
    broadcastChannel = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MULTIPLAYER - UI FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function startMultiplayer() {
  try {
    console.log('🎮 startMultiplayer called');
    goTo('s-mp-select');
  } catch (error) {
    console.error('❌ Error in startMultiplayer:', error);
    alert('Error: ' + error.message);
  }
}

function startSolo() {
  try {
    console.log('🎮 startSolo called');
    G.isMultiplayer = false;
    goTo('s-editions');
  } catch (error) {
    console.error('❌ Error in startSolo:', error);
    alert('Error: ' + error.message);
  }
}

function hostRoom() {
  console.log('🏠 hostRoom called');
  G.roomCode = generateRoomCode();
  console.log('🔐 Generated room code:', G.roomCode);
  G.playerId = generatePlayerId();
  G.playerName = document.getElementById('host-name-input') ? document.getElementById('host-name-input').value.trim() || 'Host' : 'Host';
  G.isHost = true;
  G.isMultiplayer = true;
  
  // Initialize room data
  const roomData = {
    host: G.playerId,
    players: {},
    reveals: [],
    turnOrder: [G.playerId],
    currentTurn: 0,
    gameStarted: false,
    combat: null
  };
  roomData.players[G.playerId] = {
    name: G.playerName,
    deckKey: null,
    hp: {},
    lastUpdate: Date.now()
  };
  
  console.log('📝 Calling setRoomData for new room');
  setRoomData(roomData);
  
  console.log('👂 Setting up Firebase listener for host');
  setupFirebaseListener(); // Start listening for changes
  
  // Sync local state
  G.turnOrder = roomData.turnOrder;
  G.currentTurn = roomData.currentTurn;
  G.gameStarted = roomData.gameStarted;
  G.combat = roomData.combat ? normalizeCombat(roomData.combat) : null;
  
  // Show lobby
  document.getElementById('host-code').textContent = G.roomCode;
  
  // Generate QR code
  const qrContainer = document.getElementById('qr-code');
  qrContainer.innerHTML = '';
  try {
    new QRCode(qrContainer, {
      text: G.roomCode,
      width: 200,
      height: 200,
      colorDark: '#000000',
      colorLight: '#ffffff',
    });
  } catch (e) {
    console.error('QRCode generation failed:', e);
    qrContainer.innerHTML = '<div style="color: red;">QR Code failed to load</div>';
  }
  
  initBroadcastChannel();
  startSync();
  renderLobbyPlayers();
  goTo('s-lobby-host');
}

function joinRoom() {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  const name = document.getElementById('join-name-input').value.trim();
  
  if (!code || code.length !== 6) {
    toast('Enter a valid 6-character room code');
    return;
  }
  
  if (!name) {
    toast('Enter your name');
    return;
  }
  
  G.roomCode = code;
  G.playerId = generatePlayerId();
  G.playerName = name;
  G.isHost = false;
  G.isMultiplayer = true;
  
  console.log('👤 Attempting to join room:', code, 'as player:', name);
  
  // Set up Firebase listener and wait for room data
  setupFirebaseListener().then((success) => {
    if (!success) {
      console.error('❌ setupFirebaseListener failed');
      toast('Failed to connect to room');
      G.roomCode = null;
      G.isMultiplayer = false;
      removeFirebaseListener();
      return;
    }
    
    console.log('✅ setupFirebaseListener succeeded');
    const roomData = getRoomData();
    
    if (!roomData) {
      console.error('❌ Room data is null after successful listener');
      toast('Room not found');
      G.roomCode = null;
      G.isMultiplayer = false;
      removeFirebaseListener();
      return;
    }
    
    console.log('✅ Successfully joined room:', code);
    
    // Add self to room if game hasn't started
    if (!roomData.gameStarted) {
      // Add self to players object
      if (!roomData.players[G.playerId]) {
        roomData.players[G.playerId] = {
          name: G.playerName,
          deckKey: null,
          hp: {},
          lastUpdate: Date.now()
        };
        console.log('✅ Added guest to players object');
      }
      
      // Add to turn order if not there
      if (!roomData.turnOrder) roomData.turnOrder = Object.keys(roomData.players);
      if (!roomData.turnOrder.includes(G.playerId)) {
        roomData.turnOrder.push(G.playerId);
        console.log('✅ Added guest to turnOrder');
      }
      
      // Update Firebase with guest added
      setRoomData(roomData);
    }
    
    // Sync local state
    G.turnOrder = roomData.turnOrder || [];
    G.currentTurn = roomData.currentTurn || 0;
    G.gameStarted = roomData.gameStarted || false;
    G.combat = roomData.combat ? normalizeCombat(roomData.combat) : null;
    
    updateMyPlayer();
    
    document.getElementById('guest-code').textContent = G.roomCode;
    
    initBroadcastChannel();
    startSync();
    renderLobbyPlayers();
    goTo('s-lobby-guest');
  });
}

function renderLobbyPlayers() {
  const roomData = getRoomData();
  if (!roomData || !roomData.players) return;
  
  const listId = G.isHost ? 'lobby-players-list' : 'guest-players-list';
  const list = document.getElementById(listId);
  if (!list) return; // Safety check
  
  list.innerHTML = '';
  
  // Show players in turn order
  const turnOrder = roomData.turnOrder || Object.keys(roomData.players);
  turnOrder.forEach((pid, index) => {
    const player = roomData.players[pid];
    if (!player) return;
    
    const isMe = pid === G.playerId;
    const item = document.createElement('div');
    item.className = 'lobby-player-item';
    
    const initial = player.name.charAt(0).toUpperCase();
    const deckName = player.deckKey ? DECKS[player.deckKey]?.name || 'Unknown' : 'No deck';
    const turnIndicator = roomData.gameStarted ? '' : `${index + 1}. `;
    
    item.innerHTML = `
      <div class="lobby-player-avatar">${initial}</div>
      <div class="lobby-player-info">
        <div class="lobby-player-name">${turnIndicator}${player.name}</div>
        <div class="lobby-player-deck">${deckName}</div>
      </div>
      ${isMe ? '<div class="lobby-you-badge">YOU</div>' : ''}
    `;
    
    list.appendChild(item);
  });
}

function buildOtherPlayersList() {
  const roomData = getRoomData();
  if (!roomData || !roomData.players) return;
  
  const list = document.getElementById('other-players-list');
  list.innerHTML = '';
  
  Object.entries(roomData.players).forEach(([pid, player]) => {
    if (pid === G.playerId) return; // Skip self
    
    const card = document.createElement('div');
    card.className = 'other-player-card';
    
    const deckName = player.deckKey ? DECKS[player.deckKey]?.name || 'Unknown' : 'No deck selected';
    
    let hpHTML = '';
    if (player.deckKey && player.hp) {
      const deck = DECKS[player.deckKey];
      if (deck && deck.healthBars) {
        deck.healthBars.forEach((bar, idx) => {
          const val = player.hp['bar' + idx] || 0;
          hpHTML += `
            <div class="other-hp-bar">
              <div class="other-hp-label">${bar.label}</div>
              <div class="other-hp-value">${val}</div>
            </div>
          `;
        });
      }
    }
    
    card.innerHTML = `
      <div class="other-player-header">
        <div class="other-player-name">${player.name}</div>
        <div class="other-player-deck">${deckName}</div>
      </div>
      <div class="other-player-hp">${hpHTML || '<div class="other-hp-label">No HP data</div>'}</div>
    `;
    
    list.appendChild(card);
  });
  
  if (list.children.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted)">No other players yet</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PLAYER STATUS AREA - VISIBLE TO ALL MULTIPLAYER PLAYERS
// Shows all players' current status with HP, card counts, and special abilities
// Edit CSS variables in index.html <style> section to customize:
//   - .player-status-area: max-height, padding, border styles
//   - .player-status-row: height, gap between elements
//   - .status-name: font-size (edit font-weight for boldness)
//   - .hero-back-img: height (width adjusts automatically via aspect-ratio)
//   - .status-counts: font-size (condensed info display)
//   - .special-preview: height (special ability card preview)
// ═══════════════════════════════════════════════════════════════════════

function renderPlayerStatusArea() {
  if (!G.isMultiplayer) return;
  
  const roomData = getRoomData();
  if (!roomData || !roomData.players) return;
  
  const container = document.getElementById('player-status-area');
  if (!container) return; // Safety check
  
  container.innerHTML = '';
  
  const turnOrder = G.turnOrder || roomData.turnOrder || Object.keys(roomData.players);
  
  turnOrder.forEach((pid, index) => {
    const player = roomData.players[pid];
    if (!player) return;
    
    const isMe = pid === G.playerId;
    const isActiveTurn = G.turnOrder.length > 0 && G.turnOrder[G.currentTurn] === pid;

    const row = document.createElement('div');
    row.className = 'player-status-row' + (isActiveTurn ? ' active-turn' : '');
    
    // Get deck data for hero image
    const deck = player.deckKey ? DECKS[player.deckKey] : null;
    const heroImagePath = deck ? deck.image : '';
    
    // Check if player has special ability card
    const specialCard = player.specialCurrent;
    
    let hpHTML = '';
    if (player.deckKey && player.hp) {
      if (deck && deck.healthBars) {
        deck.healthBars.forEach((bar, idx) => {
          const val = player.hp['bar' + idx] || 0;
          const heartColor = bar.color || '#ffffff';
          hpHTML += `<span class="status-hp-heart" style="color: ${heartColor};">❤️ ${val}</span>`;
        });
      }
    }
    
    // Get card counts
    const counts = player.cardCounts || { draw: 0, hand: 0, staged: 0, intermediate: 0, discard: 0 };
    
    // Build HTML
    let specialHTML = '';
    if (specialCard && specialCard.image) {
      specialHTML = `
        <div class="status-special">
          <img src="${specialCard.image}" alt="Special" class="special-preview" onclick="viewPlayerSpecialCard('${specialCard.image}')">
        </div>
      `;
    }
    
    const turnBadge = isActiveTurn
      ? `<div class="turn-badge ${isMe ? 'my-turn' : 'their-turn'}">${isMe ? 'YOUR TURN' : 'ACTIVE'}</div>`
      : '';

    row.innerHTML = `
      <div class="status-name">${player.name} ${isMe ? '(You)' : ''}</div>
      <div class="status-hero">
        <img src="${heroImagePath}" alt="Hero" class="hero-back-img">
        <button class="info-btn-small" onclick="showPlayerDeckInfo('${pid}')">i</button>
      </div>
      ${specialHTML}
      <div class="status-hp">${hpHTML}</div>
      <div class="status-counts">
        <span>D:${counts.draw}</span>
        <span>H:${counts.hand}</span>
        <span>S:${counts.staged}</span>
        <span>I:${counts.intermediate}</span>
        <span>Disc:${counts.discard}</span>
      </div>
      ${turnBadge}
    `;

    container.appendChild(row);
  });

  // Update End Turn button state
  const endTurnBtn = document.getElementById('end-turn-btn');
  if (endTurnBtn && G.isMultiplayer && G.gameStarted) {
    const myTurn = G.turnOrder.length > 0 && G.turnOrder[G.currentTurn] === G.playerId;
    const currentPid = G.turnOrder[G.currentTurn];
    const currentRoomData = getRoomData();
    const currentName = currentRoomData && currentRoomData.players && currentRoomData.players[currentPid]
      ? currentRoomData.players[currentPid].name : '?';
    endTurnBtn.disabled = !myTurn;
    endTurnBtn.textContent = myTurn ? '✓ End My Turn' : currentName + "'s Turn";
  }
}

function viewPlayerSpecialCard(imagePath) {
  const overlay = document.getElementById('card-overlay');
  document.getElementById('overlay-img').src = imagePath;
  overlay.style.display = 'flex';
}

function updateMyCardCounts() {
  if (!G.isMultiplayer) return;
  
  const roomData = getRoomData();
  if (!roomData || !roomData.players) return;
  
  if (!roomData.players[G.playerId]) return;
  
  roomData.players[G.playerId].cardCounts = {
    draw: G.draw.length,
    hand: G.hand.length,
    staged: G.staged.length,
    intermediate: G.intermediate.length,
    discard: G.discard.length
  };
  
  setRoomData(roomData);
}

// Sync entire local discard pile to multiplayer room data
function syncMyDiscard() {
  if (!G.isMultiplayer || !G.roomCode) return;
  const roomData = getRoomData();
  if (!roomData || !roomData.players || !roomData.players[G.playerId]) return;
  roomData.players[G.playerId].discardCards = G.discard.map(c => ({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey }));
  setRoomData(roomData);
}

function syncMyHand() {
  if (!G.isMultiplayer || !G.roomCode) return;
  const roomData = getRoomData();
  if (!roomData || !roomData.players || !roomData.players[G.playerId]) return;
  roomData.players[G.playerId].handCards = G.hand.map(c => ({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey }));
  setRoomData(roomData);
}

function showPlayerDeckInfo(pid) {
  const roomData = getRoomData();
  if (!roomData || !roomData.players[pid]) return;
  
  const player = roomData.players[pid];
  if (!player.deckKey) return;
  
  const dk = DECKS[player.deckKey];
  if (!dk) return;
  
  document.getElementById('info-sheet-img').src = dk.infoImage || '';
  
  // Show special ability if present
  const specialInfo = document.getElementById('player-special-info');
  if (dk.specialAbility && dk.specialAbility.enabled) {
    const saLabel = dk.specialAbility.label || 'Special Ability';
    specialInfo.innerHTML = `
      <div class="special-ability-title">${saLabel}</div>
    `;
    specialInfo.style.display = 'block';
  } else {
    specialInfo.style.display = 'none';
  }
  
  document.getElementById('sh-info').classList.add('open');
}

function startGame() {
  if (!G.isMultiplayer || !G.isHost) return;
  
  const roomData = getRoomData();
  if (!roomData) return;
  
  roomData.gameStarted = true;
  setRoomData(roomData);
  
  // Sync local state
  G.gameStarted = true;
  
  goTo('s-editions');
}

// END TURN MECHANIC REMOVED
// function endTurn() {
//   if (!G.isMultiplayer || !G.gameStarted) return;
//   
//   const roomData = getRoomData();
//   if (!roomData) return;
//   
//   // Move to next player
//   roomData.currentTurn = (roomData.currentTurn + 1) % roomData.turnOrder.length;
//   setRoomData(roomData);
//   
//   // Sync local state
//   G.currentTurn = roomData.currentTurn;
// }

function reorderPlayers() {
  if (!G.isMultiplayer || !G.isHost || G.gameStarted) return;
  buildReorderSheet();
  openSheet('sh-reorder-players');
}

function buildReorderSheet() {
  const roomData = getRoomData();
  if (!roomData) return;
  const order = roomData.turnOrder || [];
  const body = document.getElementById('reorder-players-body');
  body.innerHTML = '';
  order.forEach((pid, idx) => {
    const player = roomData.players[pid];
    if (!player) return;
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--surface2)';
    item.innerHTML = `
      <div style="flex:1;font-weight:600">${idx + 1}. ${player.name}</div>
      <button class="btn btn-sm btn-ghost" ${idx === 0 ? 'disabled' : ''} onclick="movePlayerInOrder('${pid}',-1)">↑</button>
      <button class="btn btn-sm btn-ghost" ${idx === order.length - 1 ? 'disabled' : ''} onclick="movePlayerInOrder('${pid}',1)">↓</button>
    `;
    body.appendChild(item);
  });
}

function movePlayerInOrder(pid, dir) {
  const roomData = getRoomData();
  if (!roomData) return;
  const order = roomData.turnOrder;
  const idx = order.indexOf(pid);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  roomData.turnOrder = order;
  setRoomData(roomData);
  buildReorderSheet();
}

function leaveLobby() {
  if (G.isMultiplayer) {
    stopSync();
    removeFirebaseListener();
    G.isMultiplayer = false;
    G.roomCode = null;
  }
  goBack('s-mp-select');
}

function endTurn() {
  if (!G.isMultiplayer || !G.gameStarted) return;

  const roomData = getRoomData();
  if (!roomData) return;

  const prevPid = G.turnOrder[G.currentTurn];
  const prevName = roomData.players[prevPid] ? roomData.players[prevPid].name : 'Unknown';

  roomData.currentTurn = (roomData.currentTurn + 1) % roomData.turnOrder.length;
  setRoomData(roomData);
  G.currentTurn = roomData.currentTurn;

  const nextPid = G.turnOrder[G.currentTurn];
  const nextName = roomData.players[nextPid] ? roomData.players[nextPid].name : 'Unknown';

  addLogEntry(prevName + ' ended turn \u2192 ' + nextName, 'turn');
  publishEvent({ action: 'turn-end' });
  renderPlayerStatusArea();
  toast(nextName + "'s turn!");
}

// ═══════════════════════════════════════════════════════════════════════
// DISCARD BROWSING - VISIBLE TO ALL MULTIPLAYER PLAYERS
// Shows a preview of each player's discard pile with the last discarded card visible
// Edit CSS variables in index.html <style> section to customize:
//   - .discard-browsing: padding, border, max-height (scroll if too many players)
//   - .discard-browsing h3: font-size (section header)
//   - .discard-player-preview: gap, padding between player groups
//   - .discard-preview-header: font-size, font-weight, color
//   - .discard-last-card: width/height (preview card dimensions)
//   - .discard-empty: color, font-size (empty state text)
// Edit HTML inline styles to customize individual cards:
//   - Change onclick handler to call different sheets or add functionality
// ═══════════════════════════════════════════════════════════════════════

function renderDiscardBrowsing() {
  if (!G.isMultiplayer) return;
  
  const roomData = getRoomData();
  if (!roomData || !roomData.players) return;
  
  const container = document.getElementById('discard-browsing');
  const turnOrder = roomData.turnOrder || Object.keys(roomData.players);
  
  let html = '<h3>Discard Piles</h3><div class="discard-previews-row">';
  
  turnOrder.forEach(pid => {
    const player = roomData.players[pid];
    if (!player) return;
    
    const discardCards = player.discardCards || [];
    const lastCard = discardCards.length > 0 ? discardCards[discardCards.length - 1] : null;
    const isMe = pid === G.playerId;
    
    html += `<div class="discard-mini-pile">`;
    html += `<div class="discard-mini-label">${player.name}${isMe ? ' (You)' : ''}</div>`;
    html += `<div class="discard-mini-count">${discardCards.length}</div>`;
    
    if (lastCard) {
      html += `<div class="discard-mini-card"><img src="${lastCard.image}" alt=""></div>`;
    } else {
      html += `<div class="discard-mini-card discard-mini-empty">🂠</div>`;
    }
    
    html += `<button class="btn btn-ghost btn-xs" onclick="openDiscardBrowseSheet('${pid}')">Browse</button>`;
    html += `</div>`;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

// Track which player's discard pile is open for browsing
let _browsingDiscardPid = null;

function openDiscardBrowseSheet(pid) {
  const roomData = getRoomData();
  if (!roomData || !roomData.players[pid]) return;
  
  _browsingDiscardPid = pid;
  const player = roomData.players[pid];
  const discardCards = player.discardCards || [];
  
  const sheet = document.getElementById('sh-discard-full');
  if (!sheet) return;
  
  const header = document.getElementById('discard-browse-header');
  const grid = document.getElementById('discard-browse-grid');
  
  header.textContent = `${player.name}'s Discard Pile (${discardCards.length} cards)`;
  grid.innerHTML = '';
  
  if (discardCards.length === 0) {
    grid.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);grid-column:1/-1">No cards discarded yet</div>';
  } else {
    discardCards.forEach((card, idx) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'discard-browse-item';
      
      const cardDiv = document.createElement('div');
      cardDiv.className = 'discard-browse-card';
      cardDiv.innerHTML = `<img src="${card.image}" alt="">`;
      cardDiv.onclick = () => openCardOverlay(card, 'other-discard');
      wrapper.appendChild(cardDiv);
      
      // "Take" button for any player
      const takeBtn = document.createElement('button');
      takeBtn.className = 'btn btn-ghost btn-xs';
      takeBtn.textContent = '→ My Hand';
      takeBtn.onclick = (e) => { e.stopPropagation(); takeFromPlayerDiscard(pid, card.uid); };
      wrapper.appendChild(takeBtn);
      
      grid.appendChild(wrapper);
    });
  }
  
  openSheet('sh-discard-full');
}

// Take a card from any player's discard pile and add to my hand
function takeFromPlayerDiscard(pid, cardUid) {
  // Re-read fresh room data to avoid stale cache race conditions
  const roomData = getRoomData();
  if (!roomData || !roomData.players[pid]) return;
  
  const player = roomData.players[pid];
  if (!player.discardCards) return;
  
  const cardIdx = player.discardCards.findIndex(c => c.uid === cardUid);
  if (cardIdx === -1) { toast('Card already taken'); return; }
  
  const [card] = player.discardCards.splice(cardIdx, 1);
  
  // Add to my local hand (preserve deckKey for origin tracking)
  const handCard = { image: card.image, uid: card.uid, deckKey: card.deckKey || player.deckKey };
  
  // Prevent duplicate in hand
  if (G.hand.find(c => c.uid === cardUid)) { toast('Already in hand'); return; }
  G.hand.push(handCard);

  // Log the action
  const fromName = player.name || 'unknown';
  const cName = cardLabel({ image: card.image });
  if (pid === G.playerId) {
    addLogEntry('You recovered "' + cName + '" from your own discard', 'other');
    if (G.isMultiplayer) publishEvent({ action: 'took-from-own-discard', cardName: cName });
  } else {
    addLogEntry('You took "' + cName + '" from ' + fromName + "'s discard", 'other');
    if (G.isMultiplayer) publishEvent({ action: 'took-from-discard', fromName: fromName, cardName: cName });
  }
  
  // If taking from my own pile, also remove from local G.discard
  if (pid === G.playerId) {
    G.discard = G.discard.filter(c => c.uid !== cardUid);
  }
  
  // Write the updated discard pile directly (don't re-read stale data)
  setRoomData(roomData);
  
  // Sync my own state
  if (G.isMultiplayer) { updateMyCardCounts(); syncMyHand(); }
  updateAll();
  
  // Refresh the browse sheet
  openDiscardBrowseSheet(pid);
  toast('Added to hand');
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED COMBAT ZONE - All players can add cards freely
// Data structure: combat = { [playerId]: { cards: [...], revealed: bool } }
// ═══════════════════════════════════════════════════════════════════════

function renderCombatArea() {
  if (!G.isMultiplayer) return;
  
  const combatArea = document.getElementById('combat-area');
  const roomData = getRoomData();
  const combat = roomData ? normalizeCombat(roomData.combat) : null;
  
  // Always show the combat zone header
  let html = `
    <div class="combat-header">
      <div class="combat-title">⚔️ COMBAT ZONE</div>
    </div>
  `;
  
  if (!combat || Object.keys(combat).length === 0) {
    // Empty combat zone
    html += `
      <div class="combat-placeholder">
        <div style="margin-bottom:8px">No cards in combat yet.</div>
        <div style="font-size:0.75rem;color:var(--muted)">Tap a card → "Add to Combat" or use Select Cards → "⚔️ Combat"</div>
      </div>
    `;
  } else {
    // Show each player's combat section
    const turnOrder = (roomData.turnOrder || Object.keys(roomData.players || {}));
    
    html += '<div class="combat-players-grid">';
    
    turnOrder.forEach(pid => {
      const entry = combat[pid];
      if (!entry || !entry.cards || entry.cards.length === 0) return;
      
      const player = roomData.players[pid];
      const pName = player ? player.name : 'Unknown';
      const isMe = pid === G.playerId;
      const isRevealed = entry.revealed;
      
      // Get card back image from player's deck
      const playerDeck = player && player.deckKey ? DECKS[player.deckKey] : null;
      const cardBackImg = playerDeck ? playerDeck.image : '';
      
      html += `<div class="combat-player-section ${isRevealed ? 'revealed' : ''}">`;
      html += `<div class="combat-player-header">`;
      html += `<span class="combat-player-name">${pName}</span>`;
      if (isRevealed) {
        html += `<span class="combat-revealed-badge">✓ Revealed</span>`;
      } else {
        html += `<span class="combat-hidden-badge">🎴 ${entry.cards.length} card${entry.cards.length > 1 ? 's' : ''}</span>`;
      }
      html += `</div>`;
      
      html += `<div class="combat-cards">`;
      entry.cards.forEach(card => {
        if (isRevealed) {
          html += `<div class="combat-card revealed" onclick="viewPlayerSpecialCard('${card.image}')"><img src="${card.image}" alt=""></div>`;
        } else {
          html += `<div class="combat-card face-down">${cardBackImg ? `<img src="${cardBackImg}" alt="">` : '🎴'}</div>`;
        }
      });
      html += `</div>`;
      
      // Show Ready button only for this player's own unrevealed cards
      if (isMe && !isRevealed) {
        html += `<button class="btn btn-accent btn-full" onclick="revealMyCombatCards()" style="margin-top:8px">
          🔓 Ready to Reveal
        </button>`;
      }
      // Show "Add More" button for player who already revealed
      if (isMe && isRevealed) {
        html += `<button class="btn btn-ghost btn-sm" onclick="addMoreToCombat()" style="margin-top:6px">
          + Add More Cards
        </button>`;
      }
      
      html += `</div>`;
    });
    
    html += '</div>';
  }
  
  // Always show Clear Combat button if there are cards
  if (combat && Object.keys(combat).length > 0) {
    html += `
      <div class="combat-actions">
        <button class="btn btn-ghost btn-sm" onclick="clearCombatZone()">🗑️ Clear Combat</button>
      </div>
    `;
  }
  
  combatArea.innerHTML = html;
}

// Add a single card to combat (from card overlay)
function addCardToCombat(card) {
  if (!G.isMultiplayer) { toast('Not in multiplayer'); return; }
  
  const roomData = getRoomData();
  if (!roomData) { toast('No room data'); return; }
  
  // Initialize combat object if it doesn't exist
  if (!roomData.combat) roomData.combat = {};
  
  // Initialize this player's section if needed
  if (!roomData.combat[G.playerId]) {
    roomData.combat[G.playerId] = { cards: [], revealed: false };
  }
  if (!roomData.combat[G.playerId].cards) {
    roomData.combat[G.playerId].cards = [];
  }
  
  // Remove card from hand
  G.hand = G.hand.filter(c => c.uid !== card.uid);
  
  // Add to combat
  roomData.combat[G.playerId].cards.push({ image: card.image, uid: card.uid });
  
  // If player already revealed, new cards are auto-revealed
  // (already handled by the revealed flag on the player entry)
  
  setRoomData(roomData);
  G.combat = normalizeCombat(roomData.combat);
  const isRnd = card.uid === _randomPickedUid;
  if (isRnd) _randomPickedUid = null;
  addLogEntry((isRnd ? '🎲 Random: ' : '') + 'You added “' + cardLabel(card) + '” to combat from hand ⚔️', 'combat');
  publishEvent({ action: 'added-to-combat', count: 1, fromHand: true, random: isRnd || undefined });
  updateAll();
  renderCombatArea();
  toast('Card added to combat');
}

// Add multiple selected cards to combat (from select mode)
function addSelectedToCombat() {
  if (!G.isMultiplayer || !G.selected.length) return;
  
  const roomData = getRoomData();
  if (!roomData) return;
  
  if (!roomData.combat) roomData.combat = {};
  if (!roomData.combat[G.playerId]) {
    roomData.combat[G.playerId] = { cards: [], revealed: false };
  }
  if (!roomData.combat[G.playerId].cards) {
    roomData.combat[G.playerId].cards = [];
  }
  
  const selectedCards = G.hand.filter(c => G.selected.includes(c.uid));
  selectedCards.forEach(card => {
    roomData.combat[G.playerId].cards.push({ image: card.image, uid: card.uid });
    G.hand = G.hand.filter(c => c.uid !== card.uid);
  });
  
  setRoomData(roomData);
  G.combat = normalizeCombat(roomData.combat);
  addLogEntry('You added ' + selectedCards.length + ' card' + (selectedCards.length > 1 ? 's' : '') + ' from hand to combat \u2694\uFE0F', 'combat');
  publishEvent({ action: 'added-to-combat', count: selectedCards.length, fromHand: true });
  exitSel();
  updateAll();
  renderCombatArea();
  toast(`${selectedCards.length} card${selectedCards.length > 1 ? 's' : ''} added to combat`);
}

// Reveal this player's combat cards
function revealMyCombatCards() {
  if (!G.isMultiplayer) return;
  
  const roomData = getRoomData();
  if (!roomData || !roomData.combat || !roomData.combat[G.playerId]) {
    toast('No cards to reveal');
    return;
  }
  
  roomData.combat[G.playerId].revealed = true;

  setRoomData(roomData);
  G.combat = normalizeCombat(roomData.combat);
  addLogEntry('You revealed your combat cards 🔓', 'combat');
  publishEvent({ action: 'combat-reveal' });
  renderCombatArea();
  toast('Cards revealed!');
}

// Add more cards after already revealing (enters select mode)
function addMoreToCombat() {
  openSheet('sh-combat-add-more');
}

function enterCombatHandSelect() {
  closeSheet('sh-combat-add-more');
  enterSel();
  document.getElementById('sel-actions').innerHTML = `
    <button class="btn btn-accent btn-sm" onclick="addSelectedToCombat()">Add to Combat</button>
    <button class="btn btn-ghost btn-sm" onclick="exitSel()">Cancel</button>
  `;
}

function pickRandomForCombat() {
  if (!G.hand.length) { toast('No cards in hand'); return; }
  const idx = Math.floor(Math.random() * G.hand.length);
  const card = G.hand[idx];
  _randomPickedUid = card.uid;
  exitSel();
  addCardToCombat(card);
}

function pickRandomForCombatFromMenu() {
  closeSheet('sh-combat-add-more');
  pickRandomForCombat();
}

function addTopCardToCombatDirect() {
  closeSheet('sh-combat-add-more');
  if (!G.isMultiplayer) { toast('Not in multiplayer'); return; }
  if (!G.draw.length) { toast('Draw pile is empty'); return; }
  const roomData = getRoomData();
  if (!roomData) return;
  if (!roomData.combat) roomData.combat = {};
  if (!roomData.combat[G.playerId]) roomData.combat[G.playerId] = { cards: [], revealed: false };
  const card = G.draw.shift();
  roomData.combat[G.playerId].cards = roomData.combat[G.playerId].cards || [];
  roomData.combat[G.playerId].cards.push({ image: card.image, uid: card.uid });
  setRoomData(roomData);
  G.combat = normalizeCombat(roomData.combat);
  addLogEntry('You added the top card of your deck to combat ⚔️', 'combat');
  publishEvent({ action: 'added-to-combat', count: 1, fromTopDeck: true });
  updateAll();
  renderCombatArea();
  toast('Top card added to combat');
}

// Clear all combat cards — moves to intermediate (if present) or discard
function clearCombatZone() {
  if (!G.isMultiplayer) return;
  
  const roomData = getRoomData();
  if (!roomData || !roomData.combat) return;
  
  const combat = roomData.combat;
  const dk = DECKS[G.deckKey];
  const hasIntermediate = dk && dk.intermediateZone && dk.intermediateZone.enabled;
  
  // Move each player's combat cards to their discard pile (in room data)
  for (const pid of Object.keys(combat)) {
    if (!pid.startsWith('p_')) continue;
    const entry = combat[pid];
    if (!entry || !entry.cards) continue;
    
    const player = roomData.players[pid];
    if (player) {
      player.discardCards = player.discardCards || [];
      entry.cards.forEach(c => player.discardCards.push(c));
    }
    
    // If this is me, add to intermediate zone or discard locally
    if (pid === G.playerId) {
      if (hasIntermediate) {
        entry.cards.forEach(c => G.intermediate.push(c));
      } else {
        entry.cards.forEach(c => G.discard.push(c));
      }
    }
  }
  
  roomData.combat = null;
  setRoomData(roomData);
  G.combat = null;
  addLogEntry('Combat zone cleared 🗑️', 'combat');
  publishEvent({ action: 'combat-cleared' });
  updateAll();
  renderCombatArea();
  toast(hasIntermediate ? 'Combat → Intermediate Zone' : 'Combat cleared');
}

// ═══════════════════════════════════════════════════════════════════════
// CORE GAME FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function myId() {
  let id = localStorage.getItem('pid');
  if (!id) {
    id = 'p' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('pid', id);
  }
  return id;
}

function tableKey() {
  return 'staged__' + (G.deckKey || '');
}

function getTS() {
  try {
    return JSON.parse(localStorage.getItem(tableKey()) || '{}');
  } catch {
    return {};
  }
}

function setTS(o) {
  try {
    localStorage.setItem(tableKey(), JSON.stringify(o));
  } catch {}
}

let cur = 's-welcome';

function goTo(id) {
  try {
    console.log('🔄 goTo called with id:', id);
    
    // Check if element exists
    const currentEl = document.getElementById(cur);
    const nextEl = document.getElementById(id);
    
    if (!currentEl) {
      console.warn('⚠️ Current screen element not found:', cur);
    } else {
      currentEl.classList.remove('active');
    }
    
    if (!nextEl) {
      console.error('❌ Target screen element not found:', id);
      alert('Screen not found: ' + id);
      return;
    }
    
    cur = id;
    nextEl.classList.add('active');
    
    if (id === 's-play') {
      document.getElementById('s-play').scrollTop = 0;
      // Show/hide multiplayer UI elements
      if (G.isMultiplayer && G.gameStarted) {
        document.getElementById('player-status-area').style.display = 'block';
        document.getElementById('combat-area').style.display = 'block';
        document.getElementById('discard-browsing').style.display = 'block';
        document.getElementById('turn-control').style.display = 'block';
      }
      // Show deck info button only in solo mode (multiplayer has it per-player in status area)
      document.getElementById('play-bar-deck-info-btn').style.display = G.isMultiplayer ? 'none' : 'flex';
      // Show effects button only in multiplayer
      const effectsBtn = document.getElementById('play-effects-btn');
      if (effectsBtn) effectsBtn.style.display = G.isMultiplayer ? 'flex' : 'none';
      // Show hand sync icon when multiplayer
      const syncIcon = document.getElementById('hand-sync-icon');
      if (syncIcon) syncIcon.style.display = G.isMultiplayer ? 'inline' : 'none';

      renderPlayerStatusArea();
      renderDiscardBrowsing();
      renderCombatArea();
      renderActionLog();
    } else {
      document.getElementById('player-status-area').style.display = 'none';
      document.getElementById('combat-area').style.display = 'none';
      document.getElementById('discard-browsing').style.display = 'none';
      document.getElementById('turn-control').style.display = 'none';
      document.getElementById('play-bar-deck-info-btn').style.display = 'none';
      const effectsBtnH = document.getElementById('play-effects-btn');
      if (effectsBtnH) effectsBtnH.style.display = 'none';
    }
  } catch (error) {
    console.error('❌ Error in goTo:', error);
    alert('Screen navigation error: ' + error.message);
  }
}

function goBack(id) {
  document.getElementById(cur).classList.remove('active');
  cur = id;
  document.getElementById(id).classList.add('active');
}

function confirmBack() {
  if (confirm('Leave this deck? Your hand will be cleared.')) {
    G.hand = [];
    G.staged = [];
    G.selected = [];
    G.intermediate = [];
    
    // Clean up multiplayer if in a room
    if (G.isMultiplayer) {
      stopSync();
      removeFirebaseListener();
      G.isMultiplayer = false;
      G.roomCode = null;
    }
    
    const ts = getTS();
    delete ts[myId()];
    setTS(ts);
    exitSel();
    goBack('s-welcome');
  }
}

function openSheet(id) {
  if (id === 'sh-draw-browse') buildDrawBrowse();
  if (id === 'sh-discard-browse') buildDiscardBrowse();
  if (id === 'sh-search-all') buildSearchAll();
  if (id === 'sh-special-deck') buildSpecialDeckBrowse();
  if (id === 'sh-special-discard') buildSpecialDiscardBrowse();
  if (id === 'sh-other-players') buildOtherPlayersList();
  document.getElementById(id).classList.add('open');
}

function closeSheet(id) {
  document.getElementById(id).classList.remove('open');
}

document.querySelectorAll('.sheet-overlay').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el) el.classList.remove('open');
  });
});

function openDeckInfo(key, e) {
  if (e) e.stopPropagation();
  const dk = DECKS[key];
  if (!dk || !dk.infoImage) return;
  document.getElementById('info-sheet-img').src = dk.infoImage;
  document.getElementById('sh-info').classList.add('open');
}

function buildEditionGrid() {
  const grid = document.getElementById('edition-grid');
  grid.innerHTML = '';
  EDITIONS.forEach(ed => {
    const div = document.createElement('div');
    div.className = 'edition-item';
    div.innerHTML = `<img src="${ed.image}" alt="" onerror="this.style.opacity='.25'">`;
    div.onclick = () => selectEdition(ed);
    grid.appendChild(div);
  });
}

function selectEdition(ed) {
  G.editionId = ed.id;
  const grid = document.getElementById('deck-grid');
  grid.innerHTML = '';
  ed.decks.forEach(key => {
    const dk = DECKS[key];
    if (!dk) return;
    const div = document.createElement('div');
    div.className = 'deck-item';
    div.innerHTML = `<img src="${dk.image}" alt="" onerror="this.style.opacity='.25'">
      <div class="info-btn" onclick="openDeckInfo('${key}',event)">i</div>`;
    div.onclick = () => selectDeck(key);
    grid.appendChild(div);
  });
  goTo('s-decks');
}

function selectDeck(key) {
  const dk = DECKS[key];
  G.deckKey = key;
  G.draw = shuffle(dk.cards.map((c, i) => ({ ...c, uid: key + '_' + c.id + '_' + i, deckKey: key })));
  G.discard = [];
  G.hand = [];
  G.staged = [];
  G.selected = [];
  G.selectMode = false;
  G.intermediate = [];

  G.hp = {};
  (dk.healthBars || []).forEach((bar, idx) => {
    G.hp['bar' + idx] = bar.startValue;
  });

  if (dk.intermediateZone && dk.intermediateZone.enabled) {
    document.getElementById('intermediate-section').style.display = 'block';
    document.getElementById('intermediate-label').textContent = dk.intermediateZone.name;
  } else {
    document.getElementById('intermediate-section').style.display = 'none';
  }

  initSpecialAbility(dk);

  const barDeckImg = document.getElementById('bar-deck-img');
  if (barDeckImg) barDeckImg.src = dk.image;
  buildHealthBars(dk);
  
  // Show multiplayer elements if in multiplayer mode
  if (G.isMultiplayer) {
    updateMyPlayer();
    updateMyCardCounts(); // Initialize card counts
  }
  
  exitSel();
  buildDrawStack();
  updateAll();
  goTo('s-play');
}

function buildHealthBars(dk) {
  const grid = document.getElementById('hp-grid');
  grid.innerHTML = '';
  (dk.healthBars || []).forEach((bar, idx) => {
    const widget = document.createElement('div');
    widget.className = 'hp-widget';
    const sizeMap = { small: 32, medium: 42, large: 52 };
    const heartSize = sizeMap[bar.size] || 42;
    widget.innerHTML = `
      <div class="hp-heart" style="--hp-color:${bar.color}">
        <svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg" style="width:${heartSize}px;height:${heartSize}px">
          <path d="M50 85 C50 85 5 55 5 28 C5 12 17 2 30 2 C38 2 45 6 50 13 C55 6 62 2 70 2 C83 2 95 12 95 28 C95 55 50 85 50 85Z"/>
        </svg>
      </div>
      <div class="hp-controls">
        <div class="hp-label">${bar.label}</div>
        <div class="hp-value" id="hp-bar${idx}">${bar.startValue}</div>
        <div class="hp-btn-row">
          <div class="hp-btn" onclick="hpChange('bar${idx}',-1)">−</div>
          <div class="hp-btn" onclick="hpChange('bar${idx}',+1)">+</div>
        </div>
      </div>`;
    grid.appendChild(widget);
  });
}

function hpChange(barKey, delta) {
  const prevVal = G.hp[barKey];
  G.hp[barKey] = Math.max(0, G.hp[barKey] + delta);
  document.getElementById('hp-' + barKey).textContent = G.hp[barKey];

  const idx = parseInt(barKey.replace('bar', ''));
  const dk = DECKS[G.deckKey];
  const barLabel = dk && dk.healthBars && dk.healthBars[idx] ? dk.healthBars[idx].label : barKey;
  const verb = delta > 0 ? '+' + delta : '' + delta;
  addLogEntry(barLabel + ': ' + verb + ' \u2192 ' + G.hp[barKey] + ' HP', 'hp');
  if (G.isMultiplayer) publishEvent({ action: 'hp-change', barLabel: barLabel, from: prevVal, to: G.hp[barKey], delta: delta });

  if (G.isMultiplayer) {
    updateMyPlayer();
  }
}

function buildDrawStack() {
  const wrap = document.getElementById('draw-stack-wrap');
  const dk = DECKS[G.deckKey];
  if (!G.draw.length) {
    wrap.innerHTML = `<div class="stack-empty">Empty</div>`;
    return;
  }
  wrap.innerHTML = `<div class="draw-stack" onclick="drawCard()">
    <div class="stack-card"></div><div class="stack-card"></div>
    <div class="stack-card stack-top"><img src="${dk.image}" alt="" onerror="this.style.opacity='.2'"></div>
    <div class="draw-stack-badge" id="draw-badge">${G.draw.length}</div>
  </div>`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawCard() {
  if (!G.draw.length) {
    toast('Draw pile is empty');
    return;
  }
  const c = G.draw.shift();
  G.hand.push(c);
  addLogEntry('You drew: ' + cardLabel(c), 'draw');
  if (G.isMultiplayer) { publishEvent({ action: 'drew', count: 1 }); syncMyHand(); }
  updateAll();
}

function shuffleDraw() {
  G.draw = shuffle(G.draw);
  addLogEntry('You shuffled the draw pile', 'other');
  buildDrawBrowse();
  toast('Shuffled');
  updateAll();
}

function shuffleHandIn() {
  if (!G.hand.length) {
    toast('Hand is empty');
    return;
  }
  const hCount = G.hand.length;
  G.draw = shuffle([...G.draw, ...G.hand]);
  G.hand = [];
  addLogEntry('You shuffled hand (' + hCount + ' card' + (hCount > 1 ? 's' : '') + ') into deck', 'other');
  if (G.isMultiplayer) { publishEvent({ action: 'shuffled-hand-in', count: hCount }); syncMyHand(); }
  updateAll();
  closeSheet('sh-shuffle-options');
  toast('Hand → Draw pile');
}

function shuffleDiscardIn() {
  if (!G.discard.length) {
    toast('Discard pile is empty');
    return;
  }
  const dCount = G.discard.length;
  G.draw = shuffle([...G.draw, ...G.discard]);
  G.discard = [];
  addLogEntry('You shuffled discard (' + dCount + ' card' + (dCount > 1 ? 's' : '') + ') into deck', 'other');
  if (G.isMultiplayer) { publishEvent({ action: 'shuffled-discard-in', count: dCount }); syncMyDiscard(); }
  updateAll();
  closeSheet('sh-shuffle-options');
  toast('Discard → Draw pile');
}

function discardCard(card) {
  const dk = DECKS[G.deckKey];
  scheduleCardExit(card);
  const rndPrefixDiscard = (card.uid === _randomPickedUid) ? '🎲 Random: ' : '';
  if (rndPrefixDiscard) _randomPickedUid = null;
  addLogEntry(rndPrefixDiscard + 'You discarded: ' + cardLabel(card), 'discard');
  G.hand = G.hand.filter(c => c.uid !== card.uid);
  G.staged = G.staged.filter(c => c.uid !== card.uid);

  if (dk.intermediateZone && dk.intermediateZone.enabled) {
    G.intermediate.push(card);
  } else {
    G.discard.push(card);
    if (G.isMultiplayer) {
      const roomData = getRoomData();
      if (roomData && roomData.players[G.playerId]) {
        if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
        roomData.players[G.playerId].discardCards.push({ image: card.image, uid: card.uid });
        if (!roomData.players[G.playerId].handCards) roomData.players[G.playerId].handCards = [];
        roomData.players[G.playerId].handCards = G.hand.map(c => ({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey }));
        if (!roomData.reveals) roomData.reveals = [];
        roomData.reveals.push(Object.assign({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
          action: 'discarded', cards: [{ image: card.image }] }, rndPrefixDiscard ? { random: true } : {}));
        if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
        setRoomData(roomData);
      }
    }
  }

  syncTS();
  updateAll();
}

function moveToHand(card) {
  G.intermediate = G.intermediate.filter(c => c.uid !== card.uid);
  G.hand.push(card);
  addLogEntry('You moved "' + cardLabel(card) + '" → hand', 'other');
  if (G.isMultiplayer) { publishEvent({ action: 'moved-zone-to-hand', cardName: cardLabel(card) }); syncMyHand(); syncMyDiscard(); updateMyCardCounts(); }
  updateAll();
  closeCardOverlay();
  toast('Moved to hand');
}

function moveToDiscard(card) {
  G.intermediate = G.intermediate.filter(c => c.uid !== card.uid);
  G.discard.push(card);
  addLogEntry('You moved "' + cardLabel(card) + '" → discard', 'discard');
  if (G.isMultiplayer) {
    // Single write: push to discardCards + append reveal event atomically
    const roomData = getRoomData();
    if (roomData && roomData.players && roomData.players[G.playerId]) {
      if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
      roomData.players[G.playerId].discardCards.push({ image: card.image, uid: card.uid, deckKey: card.deckKey || G.deckKey });
      if (!roomData.reveals) roomData.reveals = [];
      roomData.reveals.push({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
        action: 'moved-zone-to-discard', cardName: cardLabel(card) });
      if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
      setRoomData(roomData);
    }
  }
  updateAll();
  closeCardOverlay();
  toast('Moved to discard');
}

function returnToDeck(card, pos) {
  G.hand = G.hand.filter(c => c.uid !== card.uid);
  G.staged = G.staged.filter(c => c.uid !== card.uid);
  G.intermediate = G.intermediate.filter(c => c.uid !== card.uid);
  if (pos === 'top') G.draw.unshift(card);
  else if (pos === 'bottom') G.draw.push(card);
  else {
    G.draw.push(card);
    G.draw = shuffle(G.draw);
  }
  const posLabel = pos === 'top' ? 'top of deck' : pos === 'bottom' ? 'bottom of deck' : 'shuffled into deck';
  addLogEntry('You returned "' + cardLabel(card) + '" to ' + posLabel, 'other');
  if (G.isMultiplayer) { publishEvent({ action: 'returned-to-deck', count: 1, pos: pos || 'shuffle' }); syncMyHand(); }
  syncTS();
  updateAll();
  closeCardOverlay();
  toast('Returned to deck');
}

function syncTS() {
  const ts = getTS();
  ts[myId()] = G.staged.map(c => ({ uid: c.uid, image: c.image }));
  if (!G.staged.length) delete ts[myId()];
  setTS(ts);
}

function enterSel() {
  G.selectMode = true;
  G.selected = [];
  document.getElementById('hand-top-bar').style.display = 'flex';
  document.getElementById('sel-actions').style.display = 'flex';
  document.getElementById('hand-normal').style.display = 'none';
  // Show combat button in select mode if multiplayer
  const combatBtn = document.getElementById('sel-combat-btn');
  if (combatBtn) combatBtn.style.display = (G.isMultiplayer && G.gameStarted) ? 'inline-flex' : 'none';
  renderHand();
}

function exitSel() {
  G.selectMode = false;
  G.selected = [];
  document.getElementById('hand-top-bar').style.display = 'none';
  document.getElementById('sel-actions').style.display = 'none';
  document.getElementById('hand-normal').style.display = 'block';
  renderHand();
}

function selectAll() {
  G.selected = G.hand.map(c => c.uid);
  updHint();
  renderHand();
}

function clearSel() {
  G.selected = [];
  updHint();
  renderHand();
}

function updHint() {
  document.getElementById('select-hint').textContent = G.selected.length + ' selected';
}

function toggleSel(uid) {
  G.selected.includes(uid) ? (G.selected = G.selected.filter(x => x !== uid)) : G.selected.push(uid);
  updHint();
  renderHand();
}

function stageSelected() {
  if (!G.selected.length) {
    toast('Select at least one card');
    return;
  }
  const toAdd = G.hand.filter(c => G.selected.includes(c.uid) && !G.staged.find(s => s.uid === c.uid));
  G.staged = [...G.staged, ...toAdd];
  syncTS();
  exitSel();
  updateAll();
  toast(toAdd.length + ' card' + (toAdd.length > 1 ? 's' : '') + ' staged');
}

function discardSelected() {
  if (!G.selected.length) {
    toast('Select at least one card');
    return;
  }
  const dk = DECKS[G.deckKey];
  const discarded = G.hand.filter(c => G.selected.includes(c.uid));
  discarded.forEach(c => scheduleCardExit(c));
  if (discarded.length > 0) addLogEntry('You discarded ' + discarded.length + ' card' + (discarded.length > 1 ? 's' : ''), 'discard');
  discarded.forEach(c => {
    G.hand = G.hand.filter(x => x.uid !== c.uid);
    G.staged = G.staged.filter(x => x.uid !== c.uid);
    if (dk.intermediateZone && dk.intermediateZone.enabled) {
      G.intermediate.push(c);
    } else {
      G.discard.push(c);
      // Sync discard to multiplayer
      if (G.isMultiplayer) {
        const roomData = getRoomData();
        if (roomData && roomData.players[G.playerId]) {
          if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
          roomData.players[G.playerId].discardCards.push({ image: c.image, uid: c.uid });
          setRoomData(roomData);
        }
      }
    }
  });
  // Notify other players
  if (G.isMultiplayer && discarded.length > 0) {
    publishReveal(discarded.map(c => ({ image: c.image })));
    // Override action to 'discarded'
    const roomData = getRoomData();
    if (roomData && roomData.reveals && roomData.reveals.length > 0) {
      roomData.reveals[roomData.reveals.length - 1].action = 'discarded';
      setRoomData(roomData);
    }
    syncMyHand();
  }
  const count = discarded.length;
  syncTS();
  exitSel();
  updateAll();
  toast(count + ' discarded');
}

function putSelectedInDeck() {
  if (!G.selected.length) {
    toast('Select at least one card');
    return;
  }
  openSheet('sh-put-in-deck');
}

function putInDeck(pos) {
  if (!G.selected.length) {
    closeSheet('sh-put-in-deck');
    return;
  }
  const cards = G.hand.filter(c => G.selected.includes(c.uid));
  cards.forEach(c => {
    G.hand = G.hand.filter(x => x.uid !== c.uid);
    if (pos === 'top') G.draw.unshift(c);
    else if (pos === 'bottom') G.draw.push(c);
    else G.draw.push(c);
  });
  if (pos === 'shuffle') G.draw = shuffle(G.draw);
  const putPosLabel = pos === 'top' ? 'top of deck' : pos === 'bottom' ? 'bottom of deck' : 'shuffled into deck';
  addLogEntry('You returned ' + cards.length + ' card' + (cards.length > 1 ? 's' : '') + ' to ' + putPosLabel, 'other');
  if (G.isMultiplayer) { publishEvent({ action: 'returned-to-deck', count: cards.length, pos: pos }); syncMyHand(); }
  closeSheet('sh-put-in-deck');
  exitSel();
  updateAll();
  toast(`${cards.length} card${cards.length > 1 ? 's' : ''} → deck`);
}

function stageCard(card) {
  if (G.staged.find(c => c.uid === card.uid)) {
    G.staged = G.staged.filter(c => c.uid !== card.uid);
    toast('Un-staged');
  } else {
    G.staged.push(card);
    toast('Staged');
  }
  syncTS();
  updateAll();
  closeCardOverlay();
}

function unstageAll() {
  G.staged = [];
  syncTS();
  updateAll();
  toast('All un-staged');
}

function pickRandom(zone) {
  let pool = [];
  if (zone === 'draw') pool = G.draw;
  else if (zone === 'hand') pool = G.hand;
  else if (zone === 'intermediate') pool = G.intermediate;
  else if (zone === 'discard') pool = G.discard;

  if (!pool.length) {
    toast('No cards in ' + zone);
    return;
  }

  const idx = Math.floor(Math.random() * pool.length);
  const card = pool[idx];
  _randomPickedUid = card.uid;

  const t = document.getElementById('toast');
  t.innerHTML = '<span class="dice-icon">🎲</span> Rolling...';
  t.classList.add('show');

  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => {
      if (zone === 'intermediate') {
        openCardOverlay(card, 'intermediate');
      } else {
        openCardOverlay(card, 'hand');
      }
    }, 200);
  }, 600);
}

let _overlayCard = null;
let _overlayMenu = 'main';
let _overlaySource = 'hand';

function openCardOverlay(card, source = 'hand') {
  _overlayCard = card;
  _overlayMenu = 'main';
  _overlaySource = source;
  document.getElementById('overlay-img').src = card.image;
  renderOverlayMenu();
  document.getElementById('card-overlay').classList.add('open');
}

function closeCardOverlay() {
  document.getElementById('card-overlay').classList.remove('open');
  _overlayCard = null;
  _overlayMenu = 'main';
  _overlaySource = 'hand';
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('card-overlay')) closeCardOverlay();
}

function renderOverlayMenu() {
  const card = _overlayCard;
  const isStaged = !!G.staged.find(c => c.uid === card.uid);
  const acts = document.getElementById('overlay-actions');
  acts.innerHTML = '';

  if (_overlayMenu === 'main') {
    if (_overlaySource === 'special') {
      const note = document.createElement('div');
      note.style.cssText = 'text-align:center;color:var(--muted);font-size:0.76rem;padding:20px';
      note.textContent = 'This is your special ability card. Use the button on the play page to activate it.';
      acts.appendChild(note);
    } else if (_overlaySource === 'other-discard') {
      // Card from another player's discard — just view, take is via the browse sheet button
      const note = document.createElement('div');
      note.style.cssText = 'text-align:center;color:var(--muted);font-size:0.76rem;padding:12px';
      note.textContent = 'Card from discard pile. Use the "→ My Hand" button in browse view to take it.';
      acts.appendChild(note);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-ghost btn-full';
      closeBtn.textContent = 'Close';
      closeBtn.onclick = () => closeCardOverlay();
      acts.appendChild(closeBtn);
    } else if (_overlaySource === 'intermediate') {
      [
        { label: '▶ Activate (→ Discard)', cls: 'btn btn-accent btn-full', fn: () => playFromIntermediate(card) },
        { label: '→ Hand', cls: 'btn btn-ghost btn-full', fn: () => moveToHand(card) },
        { label: '→ Discard (silent)', cls: 'btn btn-ghost btn-full', fn: () => moveToDiscard(card) },
        { label: 'Return to Deck', cls: 'btn btn-ghost btn-full', fn: () => { _overlayMenu = 'return'; renderOverlayMenu(); } },
      ].forEach(b => {
        const btn = document.createElement('button');
        btn.className = b.cls;
        btn.textContent = b.label;
        btn.onclick = b.fn;
        acts.appendChild(btn);
      });
    } else {
      const buttons = [
        { label: '▶ Play', cls: 'btn btn-accent btn-full', fn: () => playCard(card) },
        { label: 'Discard', cls: 'btn btn-ghost btn-full', fn: () => { discardCard(card); closeCardOverlay(); toast('Discarded'); } },
        { label: 'Return to Deck', cls: 'btn btn-ghost btn-full', fn: () => { _overlayMenu = 'return'; renderOverlayMenu(); } },
      ];
      
      // Add combat option if in multiplayer
      if (G.isMultiplayer && G.gameStarted) {
        buttons.push({
          label: '⚔️ Add to Combat',
          cls: 'btn btn-red btn-full',
          fn: () => addCardToCombat(card)
        });
      }
      
      buttons.forEach(b => {
        const btn = document.createElement('button');
        btn.className = b.cls;
        btn.textContent = b.label;
        btn.onclick = b.fn;
        acts.appendChild(btn);
      });
    }
  } else if (_overlayMenu === 'return') {
    const sub = document.createElement('div');
    sub.className = 'overlay-submenu';
    sub.innerHTML = `
      <div class="menu-back-btn" onclick="_overlayMenu='main';renderOverlayMenu()">
        <svg viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg>
        Back
      </div>`;
    [
      { label: 'Shuffle into Deck', fn: () => returnToDeck(card, 'shuffle') },
      { label: 'Return to Top', fn: () => returnToDeck(card, 'top') },
      { label: 'Return to Bottom', fn: () => returnToDeck(card, 'bottom') },
    ].forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-full';
      btn.textContent = b.label;
      btn.onclick = b.fn;
      sub.appendChild(btn);
    });
    acts.appendChild(sub);
  }
}


function discardAllStaged() {
  const dk = DECKS[G.deckKey];
  G.staged.forEach(c => {
    G.hand = G.hand.filter(x => x.uid !== c.uid);
    if (dk.intermediateZone && dk.intermediateZone.enabled) {
      G.intermediate.push(c);
    } else {
      G.discard.push(c);
      
      // Sync discard cards in multiplayer
      if (G.isMultiplayer) {
        const roomData = getRoomData();
        if (roomData && roomData.players[G.playerId]) {
          if (!roomData.players[G.playerId].discardCards) {
            roomData.players[G.playerId].discardCards = [];
          }
          roomData.players[G.playerId].discardCards.push({ image: c.image, uid: c.uid });
          setRoomData(roomData);
        }
      }
    }
  });
  G.staged = [];
  const ts = getTS();
  delete ts[myId()];
  setTS(ts);
  if (G.isMultiplayer) syncMyHand();
  updateAll();
  goBack('s-play');
  toast('All discarded');
}

// ═══════════════════════════════════════════════════════════════════════
// ACTION LOG, COLLAPSIBLE SECTIONS, CARD LABEL HELPERS
// ═══════════════════════════════════════════════════════════════════════

let _actionLog = [];

function cardLabel(card) {
  const img = (card && card.image) ? card.image : '';
  const match = img.match(/\d+ x (.+)\.png$/i);
  if (match) return match[1];
  return img.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'card';
}

function timeLabel(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0') + ':' +
         d.getSeconds().toString().padStart(2, '0');
}

function addLogEntry(text, type) {
  type = type || 'neutral';
  _actionLog.unshift({ text: text, type: type, time: Date.now() });
  if (_actionLog.length > 30) _actionLog.pop();
  renderActionLog();
}

function renderActionLog() {
  const container = document.getElementById('action-log');
  if (!container) return;
  if (_actionLog.length === 0) {
    container.innerHTML = '<div class="log-empty">No actions yet</div>';
    return;
  }
  container.innerHTML = _actionLog.map(function(e) {
    return '<div class="log-entry log-' + e.type + '">' +
      '<span class="log-text">' + e.text + '</span>' +
      '<span class="log-time">' + timeLabel(e.time) + '</span>' +
      '</div>';
  }).join('');
}

function toggleSection(label) {
  const section = label.closest('.play-section');
  if (section) section.classList.toggle('collapsed');
}

function updateAll() {
  const d = G.draw.length, h = G.hand.length, s = G.staged.length, di = G.discard.length, iz = G.intermediate.length;
  document.getElementById('sc-draw').textContent = d;
  document.getElementById('sc-hand').textContent = h;
  const scStaged = document.getElementById('sc-staged');
  if (scStaged) scStaged.textContent = s;
  document.getElementById('sc-discard').textContent = di;
  document.getElementById('sc-intermediate').textContent = iz;
  document.getElementById('draw-big').textContent = d;
  document.getElementById('discard-big').textContent = di;
  document.getElementById('bar-counts').textContent = `Draw ${d} · Hand ${h}${iz > 0 ? ` · Zone ${iz}` : ''} · Discard ${di}`;
  buildDrawStack();
  const badge = document.getElementById('draw-badge');
  if (badge) badge.textContent = d;

  document.getElementById('sel-mode-btn').style.display = h > 0 ? 'inline-flex' : 'none';
  document.getElementById('pick-random-hand-btn').style.display = h > 0 ? 'inline-flex' : 'none';
  document.getElementById('pick-random-intermediate-btn').style.display = iz > 0 ? 'inline-flex' : 'none';
  const izSelBtn = document.getElementById('intermediate-sel-mode-btn');
  if (izSelBtn) izSelBtn.style.display = iz > 0 ? 'inline-flex' : 'none';

  renderHand();
  if (document.getElementById('staged-content')) renderStaged();
  renderIntermediate();
  renderDiscard();
  
  // Update multiplayer card counts
  if (G.isMultiplayer) {
    updateMyCardCounts();
  }
  // Keep special ability display in sync (e.g. Sinbad voyage counter)
  if (G.specialMode) updateSpecialDisplay();
}

function renderHand() {
  const grid = document.getElementById('hand-grid');
  grid.innerHTML = '';
  if (!G.hand.length) {
    const emp = document.createElement('div');
    emp.className = 'hand-empty';
    emp.innerHTML = '<span class="ei">🤲</span>Tap the deck to draw';
    grid.appendChild(emp);
    return;
  }
  G.hand.forEach(card => {
    const isSel = G.selected.includes(card.uid);
    const isStaged = !!G.staged.find(c => c.uid === card.uid);
    const div = document.createElement('div');
    div.className = 'hand-card' + (isSel ? ' selected' : '') + (isStaged ? ' is-staged' : '');
    div.innerHTML = `<img src="${card.image}" alt="" onerror="this.style.opacity='.2'">
      ${isStaged ? '<div class="staged-ribbon">Staged</div>' : ''}
      <div class="hand-check"><svg viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg></div>`;
    div.onclick = G.selectMode ? () => toggleSel(card.uid) : () => openCardOverlay(card, 'hand');
    grid.appendChild(div);
  });

  // Render cards playing their exit animation
  _exitingCards.forEach((card, uid) => {
    if (G.hand.find(c => c.uid === uid)) return;
    const div = document.createElement('div');
    div.className = 'hand-card exiting';
    div.style.pointerEvents = 'none';
    div.innerHTML = '<img src="' + card.image + '" alt="">';
    grid.appendChild(div);
  });
}

function renderStaged() {
  const cont = document.getElementById('staged-content');
  const acts = document.getElementById('staged-actions');
  if (!G.staged.length) {
    cont.innerHTML = '<div class="staged-empty">Nothing staged yet</div>';
    acts.style.display = 'none';
    return;
  }
  acts.style.display = 'flex';
  const row = document.createElement('div');
  row.className = 'staged-row';
  const dk = DECKS[G.deckKey];
  G.staged.forEach(() => {
    const c = document.createElement('div');
    c.className = 'staged-card';
    c.innerHTML = `<img src="${dk.image}" alt="" onerror="this.style.opacity='.2'">`;
    row.appendChild(c);
  });
  cont.innerHTML = '';
  cont.appendChild(row);
}

function renderIntermediate() {
  const cont = document.getElementById('intermediate-content');
  if (!G.intermediate.length) {
    cont.innerHTML = '<div class="intermediate-empty">No cards here yet</div>';
    return;
  }
  const row = document.createElement('div');
  row.className = 'intermediate-zone';
  G.intermediate.forEach(card => {
    const c = document.createElement('div');
    const isSel = G.intermediateSelectMode && G.intermediateSelected.includes(card.uid);
    c.className = 'intermediate-card' + (isSel ? ' selected' : '');
    c.innerHTML = `<img src="${card.image}" alt="" onerror="this.style.opacity='.2'">`;
    c.onclick = G.intermediateSelectMode
      ? () => intermediateToggleSel(card.uid)
      : () => openCardOverlay(card, 'intermediate');
    row.appendChild(c);
  });
  cont.innerHTML = '';
  cont.appendChild(row);
}

function enterIntermediateSel() {
  G.intermediateSelectMode = true;
  G.intermediateSelected = [];
  document.getElementById('intermediate-top-bar').style.display = 'flex';
  document.getElementById('intermediate-sel-actions').style.display = 'flex';
  document.getElementById('intermediate-normal').style.display = 'none';
  renderIntermediate();
}

function exitIntermediateSel() {
  G.intermediateSelectMode = false;
  G.intermediateSelected = [];
  document.getElementById('intermediate-top-bar').style.display = 'none';
  document.getElementById('intermediate-sel-actions').style.display = 'none';
  document.getElementById('intermediate-normal').style.display = 'block';
  renderIntermediate();
}

function intermediateSelectAll() {
  G.intermediateSelected = G.intermediate.map(c => c.uid);
  intermediateUpdHint();
  renderIntermediate();
}

function intermediateSelClear() {
  G.intermediateSelected = [];
  intermediateUpdHint();
  renderIntermediate();
}

function intermediateUpdHint() {
  document.getElementById('intermediate-hint').textContent = G.intermediateSelected.length + ' selected';
}

function intermediateToggleSel(uid) {
  G.intermediateSelected.includes(uid)
    ? (G.intermediateSelected = G.intermediateSelected.filter(x => x !== uid))
    : G.intermediateSelected.push(uid);
  intermediateUpdHint();
  renderIntermediate();
}

function playFromIntermediate(card) {
  const isRnd = card.uid === _randomPickedUid;
  if (isRnd) _randomPickedUid = null;
  G.intermediate = G.intermediate.filter(c => c.uid !== card.uid);
  G.discard.push(card);
  addLogEntry((isRnd ? '🎲 Random: ' : '') + 'You activated: ' + cardLabel(card), 'play');
  if (G.isMultiplayer) {
    const roomData = getRoomData();
    if (roomData && roomData.players && roomData.players[G.playerId]) {
      if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
      roomData.players[G.playerId].discardCards.push({ image: card.image, uid: card.uid, deckKey: card.deckKey || G.deckKey });
      if (!roomData.reveals) roomData.reveals = [];
      roomData.reveals.push(Object.assign({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
        action: 'activated-special', cards: [{ image: card.image }] }, isRnd ? { random: true } : {}));
      if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
      setRoomData(roomData);
    }
  }
  syncTS();
  updateAll();
  closeCardOverlay();
  toast('Activated!');
}

function playSelectedFromIntermediate() {
  if (!G.intermediateSelected.length) { toast('Select at least one card'); return; }
  const cards = G.intermediate.filter(c => G.intermediateSelected.includes(c.uid));
  cards.forEach(card => {
    G.intermediate = G.intermediate.filter(c => c.uid !== card.uid);
    G.discard.push(card);
  });
  addLogEntry('You activated ' + cards.length + ' card' + (cards.length > 1 ? 's' : ''), 'play');
  if (G.isMultiplayer) {
    const roomData = getRoomData();
    if (roomData && roomData.players && roomData.players[G.playerId]) {
      if (!roomData.players[G.playerId].discardCards) roomData.players[G.playerId].discardCards = [];
      cards.forEach(c => roomData.players[G.playerId].discardCards.push({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey }));
      if (!roomData.reveals) roomData.reveals = [];
      roomData.reveals.push({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
        action: 'activated-special', cards: cards.map(c => ({ image: c.image })) });
      if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
      setRoomData(roomData);
    }
  }
  exitIntermediateSel();
  syncTS();
  updateAll();
  toast(cards.length + ' activated!');
}

function discardSelectedFromIntermediate() {
  if (!G.intermediateSelected.length) { toast('Select at least one card'); return; }
  const cards = G.intermediate.filter(c => G.intermediateSelected.includes(c.uid));
  cards.forEach(card => {
    G.intermediate = G.intermediate.filter(c => c.uid !== card.uid);
    G.discard.push(card);
  });
  addLogEntry('You moved ' + cards.length + ' card' + (cards.length > 1 ? 's' : '') + ' → discard', 'discard');
  if (G.isMultiplayer) syncMyDiscard();
  exitIntermediateSel();
  updateAll();
  toast(cards.length + ' discarded');
}

function renderDiscard() {
  const vis = document.getElementById('discard-visual');
  if (!G.discard.length) {
    vis.innerHTML = '🂠';
    return;
  }
  const top = G.discard[G.discard.length - 1];
  vis.innerHTML = `<img src="${top.image}" alt="" onerror="this.innerHTML='🂠'">`;
}

function buildDrawBrowse(n) {
  const body = document.getElementById('draw-browse-body');
  body.innerHTML = '';

  // Update sheet title
  const titleEl = document.querySelector('#sh-draw-browse .sheet-title');
  if (titleEl) {
    if (n != null) {
      titleEl.textContent = n === 'all' ? 'Draw Pile (All)' : `Top ${n} Cards`;
    } else {
      titleEl.textContent = 'Draw Pile';
    }
  }

  if (!G.draw.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:32px 0;font-size:.78rem">Draw pile is empty</p>';
    return;
  }

  // Only show shuffle buttons in full-browse mode (no n param)
  if (n == null) {
    const shuffleBtn = document.createElement('button');
    shuffleBtn.className = 'btn btn-ghost btn-sm btn-full';
    shuffleBtn.style.marginBottom = '10px';
    shuffleBtn.textContent = 'Shuffle Draw Pile';
    shuffleBtn.onclick = shuffleDraw;
    body.appendChild(shuffleBtn);

    const shuffleInBtn = document.createElement('button');
    shuffleInBtn.className = 'btn btn-accent btn-sm btn-full';
    shuffleInBtn.style.marginBottom = '16px';
    shuffleInBtn.textContent = 'Shuffle Into Deck';
    shuffleInBtn.onclick = () => {
      closeSheet('sh-draw-browse');
      openSheet('sh-shuffle-options');
    };
    body.appendChild(shuffleInBtn);
  }

  const cards = (n != null && n !== 'all') ? G.draw.slice(0, n) : G.draw;

  // Log when peeking top N
  if (n != null) {
    const label = n === 'all' ? 'all' : n;
    addLogEntry(`You inspected the top ${label} cards of your draw pile`);
    if (G.isMultiplayer) publishEvent({ action: 'peeked-deck', count: n === 'all' ? -1 : n });
  }

  cards.forEach((card, idx) => {
    const item = document.createElement('div');
    item.className = 'browse-item';
    const cardBig = document.createElement('div');
    cardBig.className = 'browse-card-big';
    cardBig.innerHTML = `<img src="${card.image}" alt="" onerror="this.outerHTML='<span>🃏</span>'">`;
    item.appendChild(cardBig);
    const info = document.createElement('div');
    info.className = 'browse-info-text';
    info.textContent = `#${idx + 1} of ${cards.length}${n != null && n !== 'all' ? ` (of ${G.draw.length} total)` : ''}`;
    item.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'browse-btns';
    btns.innerHTML = `
      <button class="btn btn-sm btn-surface" onclick="drawSpecific(${idx})">→ Hand</button>
      <button class="btn btn-sm btn-ghost" ${idx === 0 ? 'disabled' : ''} onclick="moveUp(${idx})">↑ Move Up</button>
      <button class="btn btn-sm btn-ghost" ${idx === cards.length - 1 ? 'disabled' : ''} onclick="moveDown(${idx})">↓ Move Down</button>`;
    item.appendChild(btns);
    body.appendChild(item);
  });
}

function peekTopN(n) {
  closeSheet('sh-top-n-picker');
  buildDrawBrowse(n);
  document.getElementById('sh-draw-browse').classList.add('open');
}

function moveUp(idx) {
  if (idx === 0) return;
  [G.draw[idx - 1], G.draw[idx]] = [G.draw[idx], G.draw[idx - 1]];
  addLogEntry('You moved card #' + (idx + 1) + ' up in your deck', 'other');
  if (G.isMultiplayer) publishEvent({ action: 'moved-in-deck', dir: 'up', pos: idx + 1 });
  buildDrawBrowse();
  updateAll();
}

function moveDown(idx) {
  if (idx >= G.draw.length - 1) return;
  [G.draw[idx], G.draw[idx + 1]] = [G.draw[idx + 1], G.draw[idx]];
  addLogEntry('You moved card #' + (idx + 1) + ' down in your deck', 'other');
  if (G.isMultiplayer) publishEvent({ action: 'moved-in-deck', dir: 'down', pos: idx + 1 });
  buildDrawBrowse();
  updateAll();
}

function drawSpecific(idx) {
  const [card] = G.draw.splice(idx, 1);
  G.hand.push(card);
  addLogEntry('You took card #' + (idx + 1) + ' from your draw pile to hand', 'other');
  if (G.isMultiplayer) {
    syncMyHand();
    publishEvent({ action: 'drew-from-deck-position', pos: idx + 1 });
  }
  updateAll();
  buildDrawBrowse();
  toast('Added to hand');
}

function buildDiscardBrowse() {
  const body = document.getElementById('discard-browse-body');
  body.innerHTML = '';
  if (!G.discard.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:32px 0;font-size:.78rem">Nothing discarded yet</p>';
    return;
  }
  [...G.discard].reverse().forEach((card, ri) => {
    const realIdx = G.discard.length - 1 - ri;
    const item = document.createElement('div');
    item.className = 'browse-item';
    const cardBig = document.createElement('div');
    cardBig.className = 'browse-card-big';
    cardBig.innerHTML = `<img src="${card.image}" alt="" onerror="this.outerHTML='<span>🃏</span>'">`;
    item.appendChild(cardBig);
    const info = document.createElement('div');
    info.className = 'browse-info-text';
    info.textContent = ri === 0 ? 'Top of Pile' : `#${ri + 1}`;
    item.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'browse-btns';
    btns.innerHTML = `<button class="btn btn-sm btn-surface" onclick="recoverDiscard(${realIdx})">→ Hand</button>`;
    item.appendChild(btns);
    body.appendChild(item);
  });
}

function recoverDiscard(idx) {
  const [card] = G.discard.splice(idx, 1);
  G.hand.push(card);
  if (G.isMultiplayer) syncMyDiscard();
  updateAll();
  buildDiscardBrowse();
  toast('Added to hand');
}

function buildSearchAll() {
  const body = document.getElementById('search-all-body');
  body.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'search-editions-grid';

  EDITIONS.forEach(ed => {
    const edItem = document.createElement('div');
    edItem.className = 'edition-item';
    edItem.innerHTML = `<img src="${ed.image}" alt="" onerror="this.style.opacity='.25'">`;
    edItem.onclick = () => buildSearchDecks(ed);
    grid.appendChild(edItem);
  });

  body.appendChild(grid);
}

function buildSearchDecks(edition) {
  const body = document.getElementById('search-all-body');
  body.innerHTML = '';

  const backDiv = document.createElement('div');
  backDiv.className = 'menu-back-btn';
  backDiv.style.marginBottom = '16px';
  backDiv.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg> Back to Editions`;
  backDiv.onclick = buildSearchAll;
  body.appendChild(backDiv);

  const grid = document.createElement('div');
  grid.className = 'search-decks-grid';
  edition.decks.forEach(key => {
    const dk = DECKS[key];
    if (!dk) return;
    const deckItem = document.createElement('div');
    deckItem.className = 'deck-item';
    deckItem.innerHTML = `<img src="${dk.image}" alt="" onerror="this.style.opacity='.25'">`;
    deckItem.onclick = () => buildSearchCards(edition, dk, key);
    grid.appendChild(deckItem);
  });
  body.appendChild(grid);
}

function buildSearchCards(edition, deck, deckKey) {
  const body = document.getElementById('search-all-body');
  body.innerHTML = '';

  const backDiv = document.createElement('div');
  backDiv.className = 'menu-back-btn';
  backDiv.style.marginBottom = '16px';
  backDiv.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="15,18 9,12 15,6"/></svg> Back to Decks`;
  backDiv.onclick = () => buildSearchDecks(edition);
  body.appendChild(backDiv);

  const title = document.createElement('div');
  title.className = 'search-deck-title';
  title.textContent = deck.name;
  title.style.marginBottom = '14px';
  body.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'search-cards-grid';
  deck.cards.forEach(card => {
    const item = document.createElement('div');
    item.className = 'search-card-item';
    item.innerHTML = `<img src="${card.image}" alt="" onerror="this.style.opacity='.2'">`;
    item.onclick = () => {
      const newCard = { ...card, uid: deckKey + '_search_' + card.id + '_' + Date.now(), deckKey: deckKey };
      G.hand.push(newCard);
      updateAll();
      closeSheet('sh-search-all');
      toast('Added to hand');
    };
    grid.appendChild(item);
  });
  body.appendChild(grid);
}

// ═══════════════════════════════════════════════════════════════════════
// SPECIAL ABILITY
// ═══════════════════════════════════════════════════════════════════════

function initSpecialAbility(dk) {
  if (!dk.specialAbility || !dk.specialAbility.enabled) {
    document.getElementById('special-section').style.display = 'none';
    G.specialDeck = [];
    G.specialDiscard = [];
    G.specialCurrent = null;
    G.specialMode = null;
    return;
  }

  const sa = dk.specialAbility;
  G.specialMode = sa.mode;

  if (sa.mode === 'voyage-counter') {
    G.specialDeck = [];
    G.specialDiscard = [];
    G.specialCurrent = null;
    document.getElementById('special-section').style.display = 'block';
    document.getElementById('special-label').textContent = sa.label || 'Voyages Used';
    document.getElementById('special-action-btn').style.display = 'none';
    document.getElementById('special-browse-discard-btn').style.display = 'none';
    updateSpecialDisplay();
    return;
  }

  if (sa.mode === 'trick-counter') {
    G.specialDeck = [];
    G.specialDiscard = [];
    G.specialCurrent = null;
    document.getElementById('special-section').style.display = 'block';
    document.getElementById('special-label').textContent = sa.label || 'Trick Tracker';
    document.getElementById('special-action-btn').style.display = 'none';
    document.getElementById('special-browse-discard-btn').style.display = 'none';
    updateSpecialDisplay();
    return;
  }

  G.specialDeck = shuffle([...sa.deck]);
  G.specialDiscard = [];
  G.specialCurrent = G.specialDeck.shift() || null;

  document.getElementById('special-section').style.display = 'block';
  document.getElementById('special-label').textContent = sa.label;
  document.getElementById('special-action-btn').textContent = sa.buttonText;
  document.getElementById('special-action-btn').style.display = '';
  document.getElementById('special-deck-title').textContent = sa.label + ' Deck';
  document.getElementById('special-discard-title').textContent = 'Used ' + sa.label;

  if (sa.mode === 'discard') {
    document.getElementById('special-browse-discard-btn').style.display = 'block';
  } else {
    document.getElementById('special-browse-discard-btn').style.display = 'none';
  }

  updateSpecialDisplay();
}

function updateSpecialDisplay() {
  const display = document.getElementById('special-card-display');
  const count = document.getElementById('special-pile-count');
  const btn = document.getElementById('special-action-btn');

  if (G.specialMode === 'voyage-counter') {
    const vcCount = G.discard.filter(c => /voyage/i.test(c.image || '')).length;
    display.innerHTML = `<div class="voyage-counter-display"><span class="voyage-counter-num">${vcCount}</span><span class="voyage-counter-label">in discard</span></div>`;
    count.textContent = '';
    return;
  }

  if (G.specialMode === 'trick-counter') {
    const dk = DECKS[G.deckKey];
    const trickTotal = dk ? dk.cards.filter(c => /trick/i.test(c.image || '')).length : 0;
    const myPiles = [...G.draw, ...G.hand, ...G.discard, ...G.staged, ...(G.intermediate || [])];
    const inMyPiles = myPiles.filter(c => /trick/i.test(c.image || '')).length;
    const inOppHands = Math.max(0, trickTotal - inMyPiles);
    display.innerHTML = `<div class="voyage-counter-display"><span class="voyage-counter-num">${inOppHands}</span><span class="voyage-counter-label">tricks in opp. hands</span></div>`;
    count.textContent = `${inMyPiles} / ${trickTotal} still with you`;
    return;
  }

  if (G.specialCurrent) {
    display.innerHTML = `<div class="special-card-slot" onclick="viewSpecialCard()">
      <img src="${G.specialCurrent.image}" alt="" onerror="this.style.opacity='.2'">
    </div>`;
  } else {
    display.innerHTML = `<div class="special-card-empty">No card active</div>`;
  }

  count.textContent = `Deck: ${G.specialDeck.length}`;
  btn.disabled = !G.specialCurrent || (G.specialMode === 'discard' && G.specialDeck.length === 0);
}

function useSpecialAbility() {
  if (!G.specialCurrent) return;
  const dk = DECKS[G.deckKey];
  const sa = dk && dk.specialAbility ? dk.specialAbility : {};
  const saLabel = sa.label || 'Special Ability';

  if (G.specialMode === 'discard') {
    const usedCard = G.specialCurrent;
    G.specialDiscard.push(usedCard);
    G.specialCurrent = G.specialDeck.shift() || null;
    addLogEntry('You used ' + saLabel + (usedCard ? ': ' + cardLabel(usedCard) : ''), 'other');
    if (G.isMultiplayer) publishEvent({ action: 'used-special', saLabel, cardName: cardLabel(usedCard) });
    toast('Special ability used');
  } else if (G.specialMode === 'swap') {
    const currentIdx = G.specialDeck.findIndex(c => c.id === G.specialCurrent.id);
    if (currentIdx >= 0) {
      const nextIdx = (currentIdx + 1) % G.specialDeck.length;
      G.specialCurrent = G.specialDeck[nextIdx];
    } else {
      G.specialDeck.unshift(G.specialCurrent);
      G.specialCurrent = G.specialDeck[1] || G.specialDeck[0];
    }
    addLogEntry('You swapped ' + saLabel + ' → ' + cardLabel(G.specialCurrent), 'other');
    if (G.isMultiplayer) publishEvent({ action: 'used-special', saLabel, cardName: cardLabel(G.specialCurrent) });
    toast('Swapped');
  }

  updateMyPlayer(); // Sync special card change to other players
  updateSpecialDisplay();
}

function viewSpecialCard() {
  if (!G.specialCurrent) return;
  openCardOverlay(G.specialCurrent, 'special');
}

function buildSpecialDeckBrowse() {
  const body = document.getElementById('special-deck-body');
  body.innerHTML = '';

  if (!G.specialDeck.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:32px 0;font-size:.78rem">Deck is empty</p>';
    return;
  }

  const shuffleBtn = document.createElement('button');
  shuffleBtn.className = 'btn btn-ghost btn-sm btn-full';
  shuffleBtn.style.marginBottom = '16px';
  shuffleBtn.textContent = 'Shuffle Deck';
  shuffleBtn.onclick = () => {
    G.specialDeck = shuffle(G.specialDeck);
    buildSpecialDeckBrowse();
    updateSpecialDisplay();
    toast('Shuffled');
  };
  body.appendChild(shuffleBtn);

  G.specialDeck.forEach((card, idx) => {
    const item = document.createElement('div');
    item.className = 'browse-item';
    const cardBig = document.createElement('div');
    cardBig.className = 'browse-card-big';
    cardBig.innerHTML = `<img src="${card.image}" alt="" onerror="this.style.opacity='.2'">`;
    item.appendChild(cardBig);
    const info = document.createElement('div');
    info.className = 'browse-info-text';
    info.textContent = `#${idx + 1} of ${G.specialDeck.length}`;
    item.appendChild(info);

    if (G.specialMode === 'discard') {
      const btns = document.createElement('div');
      btns.className = 'browse-btns';
      btns.innerHTML = `<button class="btn btn-sm btn-accent" onclick="activateSpecialCard(${idx})">Set as Active</button>`;
      item.appendChild(btns);
    }

    body.appendChild(item);
  });
}

function activateSpecialCard(idx) {
  if (G.specialCurrent) {
    G.specialDeck.push(G.specialCurrent);
  }
  G.specialCurrent = G.specialDeck.splice(idx, 1)[0];
  updateSpecialDisplay();
  buildSpecialDeckBrowse();
  toast('Card activated');
}

function buildSpecialDiscardBrowse() {
  const body = document.getElementById('special-discard-body');
  body.innerHTML = '';

  if (!G.specialDiscard.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:32px 0;font-size:.78rem">No used cards yet</p>';
    return;
  }

  const shuffleBtn = document.createElement('button');
  shuffleBtn.className = 'btn btn-accent btn-sm btn-full';
  shuffleBtn.style.marginBottom = '16px';
  shuffleBtn.textContent = 'Shuffle Back Into Deck';
  shuffleBtn.onclick = () => {
    G.specialDeck = shuffle([...G.specialDeck, ...G.specialDiscard]);
    G.specialDiscard = [];
    updateSpecialDisplay();
    closeSheet('sh-special-discard');
    toast('Shuffled back');
  };
  body.appendChild(shuffleBtn);

  [...G.specialDiscard].reverse().forEach((card, ri) => {
    const realIdx = G.specialDiscard.length - 1 - ri;
    const item = document.createElement('div');
    item.className = 'browse-item';
    const cardBig = document.createElement('div');
    cardBig.className = 'browse-card-big';
    cardBig.innerHTML = `<img src="${card.image}" alt="" onerror="this.style.opacity='.2'">`;
    item.appendChild(cardBig);
    const info = document.createElement('div');
    info.className = 'browse-info-text';
    info.textContent = ri === 0 ? 'Most Recent' : `#${ri + 1}`;
    item.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'browse-btns';
    btns.innerHTML = `<button class="btn btn-sm btn-accent" onclick="recoverSpecialCard(${realIdx})">Set as Active</button>
      <button class="btn btn-sm btn-ghost" onclick="recoverSpecialCardToBottom(${realIdx})">\u2192 Bottom of Deck</button>`;
    item.appendChild(btns);
    body.appendChild(item);
  });
}

function recoverSpecialCard(idx) {
  if (G.specialCurrent) {
    G.specialDiscard.push(G.specialCurrent);
  }
  G.specialCurrent = G.specialDiscard.splice(idx, 1)[0];
  updateSpecialDisplay();
  buildSpecialDiscardBrowse();
  toast('Card recovered');
}

function recoverSpecialCardToBottom(idx) {
  const card = G.specialDiscard.splice(idx, 1)[0];
  G.specialDeck.push(card);
  const dk = DECKS[G.deckKey];
  addLogEntry('You returned "' + cardLabel(card) + '" to the bottom of your ' + (dk && dk.specialAbility && dk.specialAbility.label ? dk.specialAbility.label : 'special') + ' deck', 'other');
  updateSpecialDisplay();
  buildSpecialDiscardBrowse();
  toast('Returned to bottom of deck');
}

// \u2550\u2550\u2550 CARD EFFECTS \u2550\u2550\u2550

function openEffectsSheet() {
  _buildInteractHome();
  openSheet('sh-card-effects');
}

function _buildInteractHome() {
  const body = document.getElementById('interact-body');
  if (!body) return;
  body.innerHTML = `
    <div class="effects-list">
      <button class="btn btn-accent btn-full" onclick="openTopNRequest()">🔍 See Player's Top N Cards</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="openHandViewRequest()">✋ See Player's Hand</button>
    </div>`;
}

function addTopCardToCombat() {
  if (!G.isMultiplayer) { toast('Not in multiplayer'); return; }
  if (!G.draw.length) { toast('Draw pile is empty'); return; }
  const roomData = getRoomData();
  if (!roomData) return;
  if (!roomData.combat) roomData.combat = {};
  if (!roomData.combat[G.playerId]) roomData.combat[G.playerId] = { cards: [], revealed: false };
  const card = G.draw.shift();
  roomData.combat[G.playerId].cards = roomData.combat[G.playerId].cards || [];
  roomData.combat[G.playerId].cards.push({ image: card.image, uid: card.uid });
  setRoomData(roomData);
  G.combat = normalizeCombat(roomData.combat);
  addLogEntry('You added the top card of your deck to combat \u2694\ufe0f', 'combat');
  publishEvent({ action: 'added-to-combat', count: 1, fromTopDeck: true });
  updateAll();
  renderCombatArea();
  closeSheet('sh-card-effects');
  toast('Top card added to combat');
}

function openViewOpponentHandEffect(effectType) {
  const roomData = getRoomData();
  if (!roomData) return;
  const body = document.getElementById('view-opp-hand-body');
  const opponents = Object.keys(roomData.players || {}).filter(pid => pid !== G.playerId);
  if (!opponents.length) { toast('No opponents found'); return; }
  if (opponents.length === 1) { loadOpponentForEffect(opponents[0], effectType); return; }
  body.innerHTML = '<div style="padding:8px 0;font-size:.8rem;color:var(--muted);margin-bottom:8px">Select opponent:</div>';
  opponents.forEach(pid => {
    const p = roomData.players[pid];
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-full'; btn.style.marginBottom = '8px';
    btn.textContent = (p && p.name) || pid;
    btn.onclick = () => loadOpponentForEffect(pid, effectType);
    body.appendChild(btn);
  });
  document.getElementById('view-opp-hand-title').textContent = effectType === 'force-discard' ? 'Force Discard' : 'Shuffle to Deck';
  openSheet('sh-view-opp-hand');
}

function loadOpponentForEffect(pid, effectType) {
  const roomData = getRoomData();
  if (!roomData || !roomData.players[pid]) return;
  const player = roomData.players[pid];
  const handCards = player.handCards || [];
  const title = effectType === 'force-discard'
    ? (player.name || pid) + "'s Hand \u2014 Force Discard"
    : (player.name || pid) + "'s Hand \u2014 Shuffle to Deck";
  document.getElementById('view-opp-hand-title').textContent = title;
  const body = document.getElementById('view-opp-hand-body');
  body.innerHTML = '';
  if (!handCards.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px">Hand is empty or not synced yet</p>';
    openSheet('sh-view-opp-hand'); return;
  }
  handCards.forEach(card => {
    const row = document.createElement('div');
    row.className = 'inspect-card-row';
    const safeLabel = cardLabel(card).replace(/'/g, "\\'");
    const safeName = (player.name || pid).replace(/'/g, "\\'");
    const safeKey = (card.deckKey || G.deckKey).replace(/'/g, "\\'");
    const safeBtnLabel = effectType === 'force-discard' ? '\uD83D\uDDD1 Discard' : '\u2192 Deck';
    row.innerHTML = `<div class="inspect-card-thumb"><img src="${card.image}" alt=""></div>
      <div class="inspect-card-meta"><div class="inspect-card-name">${cardLabel(card)}</div></div>
      <div class="inspect-card-actions">
        <button class="btn btn-sm btn-red" onclick="executeHandEffect('${pid}','${card.uid}','${card.image}','${safeKey}','${effectType}','${safeLabel}','${safeName}')">${safeBtnLabel}</button>
      </div>`;
    body.appendChild(row);
  });
  openSheet('sh-view-opp-hand');
}

function executeHandEffect(pid, cardUid, cardImage, cardDeckKey, effectType, cardName, victimName) {
  const roomData = getRoomData();
  if (!roomData || !roomData.players[pid]) { toast('Cannot find player'); return; }
  const player = roomData.players[pid];
  // Update Firebase-side handCards if synced; the event handles the victim's side regardless
  if (player.handCards) {
    const cardIdx = player.handCards.findIndex(c => c.uid === cardUid);
    if (cardIdx !== -1) {
      player.handCards.splice(cardIdx, 1);
      if (effectType === 'force-discard') {
        if (!player.discardCards) player.discardCards = [];
        player.discardCards.push({ image: cardImage, uid: cardUid, deckKey: cardDeckKey });
      }
    }
  }
  if (!roomData.reveals) roomData.reveals = [];
  if (effectType === 'force-discard') {
    roomData.reveals.push({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
      action: 'force-discard-hand', victimId: pid, victimName: victimName,
      cardUid: cardUid, cardImage: cardImage, cardName: cardName, cardDeckKey: cardDeckKey });
    if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
    setRoomData(roomData);
    addLogEntry('You forced ' + victimName + ' to discard "' + cardName + '"', 'other');
  } else {
    roomData.reveals.push({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
      action: 'force-shuffle-to-deck', victimId: pid, victimName: victimName,
      cardUid: cardUid, cardImage: cardImage, cardName: cardName, cardDeckKey: cardDeckKey });
    if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
    setRoomData(roomData);
    addLogEntry('You shuffled "' + cardName + '" from ' + victimName + "'s hand back into their deck", 'other');
  }
  closeSheet('sh-view-opp-hand');
  closeSheet('sh-card-effects');
  toast('Done!');
}

function openInspectTopNSheet() {
  document.getElementById('inspect-top-n-title').textContent = 'Inspect Your Top Cards';
  const body = document.getElementById('inspect-top-n-body');
  body.innerHTML = `<div style="text-align:center;padding:8px 0 16px">
    <div style="font-size:.82rem;color:var(--muted);margin-bottom:12px">How many cards to inspect?</div>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      ${[2,3,4,5].map(n => `<button class="btn btn-accent btn-sm" onclick="loadInspectTopN(${n})">${n}</button>`).join('')}
    </div></div>`;
  openSheet('sh-inspect-top-n');
}

function loadInspectTopN(n) {
  if (!G.draw.length) { toast('Draw pile empty'); return; }
  n = Math.min(n, G.draw.length);
  _inspectState = { source: 'own', pid: null, cards: [], assignments: {}, deckSortOrder: [] };
  G.draw.slice(0, n).forEach((c, i) => {
    const card = { ...c, pos: i + 1 };
    _inspectState.cards.push(card);
    _inspectState.assignments[c.uid] = 'deck';
    _inspectState.deckSortOrder.push(c.uid);
  });
  renderInspectTopN();
}

function renderInspectTopN() {
  const body = document.getElementById('inspect-top-n-body');
  const n = _inspectState.cards.length;
  let html = `<div style="font-size:.72rem;color:var(--muted);margin-bottom:12px">Toggle each card to keep in deck or take to hand. Use \u2191\u2193 to reorder cards going back to deck.</div>`;
  _inspectState.cards.forEach(card => {
    const isHand = _inspectState.assignments[card.uid] === 'hand';
    const deckIdx = _inspectState.deckSortOrder.indexOf(card.uid);
    html += `<div class="inspect-card-row">
      <div class="inspect-card-thumb"><img src="${card.image}" alt=""></div>
      <div class="inspect-card-meta">
        <div class="inspect-card-name">${cardLabel(card)}</div>
        <div class="inspect-card-pos">Card #${card.pos} from top</div>
      </div>
      <div class="inspect-card-actions">
        <button class="btn btn-sm ${isHand ? 'btn-accent' : 'btn-ghost'}" onclick="toggleInspectAssign('${card.uid}')">
          ${isHand ? '\u270B Hand' : '\uD83D\uDCE4 Deck'}
        </button>
        ${!isHand ? `<button class="btn btn-xs btn-ghost" onclick="moveInspectDeckCard('${card.uid}',-1)" ${deckIdx === 0 ? 'disabled' : ''}>\u2191</button>
        <button class="btn btn-xs btn-ghost" onclick="moveInspectDeckCard('${card.uid}',1)" ${deckIdx === _inspectState.deckSortOrder.length - 1 ? 'disabled' : ''}>\u2193</button>` : ''}
      </div></div>`;
  });
  const handPicks = _inspectState.cards.filter(c => _inspectState.assignments[c.uid] === 'hand');
  const deckPicks = _inspectState.deckSortOrder.length;
  html += `<button class="btn btn-accent btn-full" style="margin-top:16px" onclick="confirmInspectTopN()">
    \u2713 Confirm: ${handPicks.length} \u2192 Hand, ${deckPicks} back to deck</button>`;
  body.innerHTML = html;
}

function toggleInspectAssign(uid) {
  if (_inspectState.assignments[uid] === 'deck') {
    _inspectState.assignments[uid] = 'hand';
    _inspectState.deckSortOrder = _inspectState.deckSortOrder.filter(x => x !== uid);
  } else {
    _inspectState.assignments[uid] = 'deck';
    _inspectState.deckSortOrder.push(uid);
  }
  renderInspectTopN();
}

function moveInspectDeckCard(uid, dir) {
  const arr = _inspectState.deckSortOrder;
  const idx = arr.indexOf(uid);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  renderInspectTopN();
}

function confirmInspectTopN() {
  const n = _inspectState.cards.length;
  const toHand = _inspectState.cards.filter(c => _inspectState.assignments[c.uid] === 'hand');
  const toDeckOrdered = _inspectState.deckSortOrder.map(uid => _inspectState.cards.find(c => c.uid === uid)).filter(Boolean);
  G.draw.splice(0, n);
  G.draw.unshift(...toDeckOrdered);
  toHand.forEach(c => G.hand.push(c));
  const handNums = toHand.map(c => '#' + c.pos).join(', ') || 'none';
  const deckDesc = toDeckOrdered.map((c, i) => '#' + c.pos + '\u2192#' + (i + 1)).join(', ') || 'none';
  addLogEntry('You inspected top ' + n + ' cards: took ' + handNums + ' to hand; returned ' + deckDesc + ' to deck', 'other');
  if (G.isMultiplayer) { publishEvent({ action: 'inspected-own-deck', count: toHand.length, total: n }); syncMyHand(); }
  closeSheet('sh-inspect-top-n');
  closeSheet('sh-card-effects');
  updateAll();
  toast('Done!');
}

function openTopNRequest() {
  const roomData = getRoomData(); if (!roomData) return;
  const opponents = Object.keys(roomData.players || {}).filter(pid => pid !== G.playerId);
  if (!opponents.length) { toast('No opponents found'); return; }
  const body = document.getElementById('interact-body');
  const oppButtons = opponents.map(pid => {
    const p = roomData.players[pid];
    const safeN = (p && p.name ? p.name : pid).replace(/'/g, "\\'");
    return `<button class="btn btn-ghost btn-full" style="margin-bottom:6px" onclick="confirmTopNRequest('${pid}','${safeN}')">${p && p.name ? p.name : pid}</button>`;
  }).join('');
  body.innerHTML = `
    <div class="interact-back-row" onclick="_buildInteractHome()">
      <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="15,18 9,12 15,6"/></svg> Back
    </div>
    <div style="font-size:.82rem;font-weight:600;margin-bottom:8px">How many cards to see?</div>
    <input type="number" id="top-n-input" value="3" min="1" max="15"
      style="width:72px;padding:6px 10px;border-radius:8px;border:1.5px solid var(--border2);background:var(--surface2);color:var(--text);font-size:1rem;margin-bottom:14px">
    <div style="font-size:.82rem;font-weight:600;margin-bottom:8px">Select player:</div>
    ${oppButtons}`;
}

function confirmTopNRequest(pid, victimName) {
  const inp = document.getElementById('top-n-input');
  const n = Math.max(1, Math.min(15, parseInt(inp ? inp.value : '3') || 3));
  requestDeckShare(pid, n, victimName);
}

function openHandViewRequest() {
  const roomData = getRoomData(); if (!roomData) return;
  const opponents = Object.keys(roomData.players || {}).filter(pid => pid !== G.playerId);
  if (!opponents.length) { toast('No opponents found'); return; }
  const body = document.getElementById('interact-body');
  const oppButtons = opponents.map(pid => {
    const p = roomData.players[pid];
    const safeN = (p && p.name ? p.name : pid).replace(/'/g, "\\'");
    return `<button class="btn btn-ghost btn-full" style="margin-bottom:6px" onclick="requestHandShare('${pid}','${safeN}')">${p && p.name ? p.name : pid}</button>`;
  }).join('');
  body.innerHTML = `
    <div class="interact-back-row" onclick="_buildInteractHome()">
      <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="15,18 9,12 15,6"/></svg> Back
    </div>
    <div style="font-size:.82rem;font-weight:600;margin-bottom:8px">Select player to view their hand:</div>
    ${oppButtons}`;
}

function requestHandShare(pid, victimName) {
  addLogEntry('You requested to see ' + victimName + "'s hand", 'other');
  publishEvent({ action: 'hand-share-request', victimId: pid, victimName: victimName });
  closeSheet('sh-card-effects');
  toast('Request sent \u2014 waiting for ' + victimName);
}

function acceptHandShare() {
  const notif = document.getElementById('hand-share-notif');
  if (notif) notif.style.display = 'none';
  if (!_pendingHandShare) return;
  syncMyHand(); // Ensure Firebase has current hand so requester can act on it
  addLogEntry('You shared your hand with ' + _pendingHandShare.requesterName, 'other');
  publishEvent({ action: 'hand-share-response', requesterId: _pendingHandShare.requesterId,
    responderId: G.playerId, victimName: G.playerName,
    handCards: G.hand.map(c => ({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey })) });
  _pendingHandShare = null;
}

function requestDeckShare(pid, n, victimName) {
  addLogEntry('You requested to peek at ' + victimName + "'s top " + n + ' cards', 'other');
  publishEvent({ action: 'deck-share-request', victimId: pid, victimName: victimName, count: n });
  closeSheet('sh-card-effects');
  toast('Request sent \u2014 waiting for ' + victimName);
}

function acceptDeckShare() {
  const notif = document.getElementById('deck-share-notif');
  if (notif) notif.style.display = 'none';
  if (!_pendingDeckShare) return;
  const n = Math.min(_pendingDeckShare.count, G.draw.length);
  if (!n) { toast('Draw pile is empty'); _pendingDeckShare = null; return; }
  const topCards = G.draw.slice(0, n).map((c, i) => ({ image: c.image, uid: c.uid, deckKey: c.deckKey || G.deckKey, pos: i + 1 }));
  addLogEntry('You shared your top ' + n + ' cards with ' + _pendingDeckShare.requesterName, 'other');
  publishEvent({ action: 'deck-share-response', requesterId: _pendingDeckShare.requesterId,
    responderId: G.playerId, victimName: G.playerName, topCards: topCards, count: n });
  _pendingDeckShare = null;
}

function buildOppTopNBrowseSheet(victimName) {
  document.getElementById('inspect-top-n-title').textContent = victimName + "'s Deck (Top " + _inspectState.cards.length + ')';
  const body = document.getElementById('inspect-top-n-body');
  body.innerHTML = '';
  if (!_inspectState.cards.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px">All cards have been actioned.</p>';
    return;
  }
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:.72rem;color:var(--muted);margin-bottom:14px';
  hint.textContent = '\u2195 Reorder, take cards to your hand, or discard them. Tap \u2713 Confirm to put remaining back on top of their deck.';
  body.appendChild(hint);
  _inspectState.cards.forEach((card, idx) => {
    const item = document.createElement('div');
    item.className = 'browse-item';
    const cardBig = document.createElement('div');
    cardBig.className = 'browse-card-big';
    cardBig.innerHTML = `<img src="${card.image}" alt="" onerror="this.outerHTML='<span>\uD83C\uDCCB</span>'">`;
    item.appendChild(cardBig);
    const info = document.createElement('div');
    info.className = 'browse-info-text';
    info.textContent = '#' + (idx + 1) + ' from top';
    item.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'browse-btns';
    const safeLabel = cardLabel(card).replace(/'/g, "\\'");
    const safeVic = victimName.replace(/'/g, "\\'");
    btns.innerHTML = `
      <button class="btn btn-sm btn-accent" onclick="oppTopNTakeToHand('${card.uid}','${safeVic}')">→ My Hand</button>
      <button class="btn btn-sm btn-red" onclick="oppTopNDiscard('${card.uid}','${safeLabel}','${safeVic}')">Discard</button>
      <button class="btn btn-sm btn-ghost" ${idx === 0 ? 'disabled' : ''} onclick="oppTopNMoveUp(${idx})">↑ Up</button>
      <button class="btn btn-sm btn-ghost" ${idx === _inspectState.cards.length - 1 ? 'disabled' : ''} onclick="oppTopNMoveDown(${idx})">↓ Down</button>`;
    item.appendChild(btns);
    body.appendChild(item);
  });
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn btn-accent btn-full';
  doneBtn.style.marginTop = '16px';
  const safeVicFinal = victimName.replace(/'/g, "\\'");
  doneBtn.textContent = '\u2713 Confirm Order \u2014 put ' + _inspectState.cards.length + ' card' + (_inspectState.cards.length !== 1 ? 's' : '') + ' back on top';
  doneBtn.onclick = () => confirmOppTopNReorder(victimName);
  body.appendChild(doneBtn);
}

function oppTopNTakeToHand(uid, victimName) {
  const card = _inspectState.cards.find(c => c.uid === uid);
  if (!card) return;
  _inspectState.cards = _inspectState.cards.filter(c => c.uid !== uid);
  _inspectState.deckSortOrder = _inspectState.deckSortOrder.filter(x => x !== uid);
  G.hand.push({ image: card.image, uid: card.uid, deckKey: card.deckKey || G.deckKey });
  const pid = _inspectState.pid;
  publishEvent({ action: 'force-deck-take-to-hand', victimId: pid, victimName: victimName,
    cardUid: uid, cardName: cardLabel(card) });
  addLogEntry('You took \u201c' + cardLabel(card) + '\u201d from ' + victimName + "'s deck to your hand", 'other');
  syncMyHand();
  updateAll();
  if (!_inspectState.cards.length) { closeSheet('sh-inspect-top-n'); toast('Done!'); return; }
  buildOppTopNBrowseSheet(victimName);
}

function oppTopNDiscard(uid, cardName, victimName) {
  const card = _inspectState.cards.find(c => c.uid === uid);
  if (!card) return;
  _inspectState.cards = _inspectState.cards.filter(c => c.uid !== uid);
  _inspectState.deckSortOrder = _inspectState.deckSortOrder.filter(x => x !== uid);
  const pid = _inspectState.pid;
  publishEvent({ action: 'force-deck-peek-discard', victimId: pid, victimName: victimName,
    cardUid: uid, cardName: cardName });
  addLogEntry('You discarded \u201c' + cardName + '\u201d from ' + victimName + "'s deck", 'discard');
  if (!_inspectState.cards.length) { closeSheet('sh-inspect-top-n'); toast('Done!'); return; }
  buildOppTopNBrowseSheet(victimName);
}

function oppTopNMoveUp(idx) {
  if (idx === 0) return;
  [_inspectState.cards[idx - 1], _inspectState.cards[idx]] = [_inspectState.cards[idx], _inspectState.cards[idx - 1]];
  const n = document.getElementById('inspect-top-n-title').textContent.replace(/'s Deck.*$/, '');
  buildOppTopNBrowseSheet(n);
}

function oppTopNMoveDown(idx) {
  if (idx >= _inspectState.cards.length - 1) return;
  [_inspectState.cards[idx], _inspectState.cards[idx + 1]] = [_inspectState.cards[idx + 1], _inspectState.cards[idx]];
  const n = document.getElementById('inspect-top-n-title').textContent.replace(/'s Deck.*$/, '');
  buildOppTopNBrowseSheet(n);
}

function confirmOppTopNReorder(victimName) {
  const pid = _inspectState.pid;
  const remaining = _inspectState.cards;
  if (!remaining.length) { closeSheet('sh-inspect-top-n'); return; }
  if (!victimName) victimName = document.getElementById('inspect-top-n-title').textContent.replace(/'s Deck.*$/, '');
  publishEvent({ action: 'force-deck-peek-reorder', victimId: pid, victimName: victimName,
    orderedUids: remaining.map(c => c.uid) });
  addLogEntry('You put ' + remaining.map((c, i) => '#' + (i + 1)).join(', ') + ' back on top of ' + victimName + "'s deck", 'other');
  closeSheet('sh-inspect-top-n');
  toast('Done!');
}

function buildOppHandViewSheet(victimName, handCards, pid) {
  document.getElementById('view-opp-hand-title').textContent = victimName + "'s Hand";
  const body = document.getElementById('view-opp-hand-body');
  body.innerHTML = '';
  if (!handCards || !handCards.length) {
    body.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px">Hand is empty</p>';
    return;
  }
  handCards.forEach(card => {
    const item = document.createElement('div');
    item.className = 'browse-item';
    const cardBig = document.createElement('div');
    cardBig.className = 'browse-card-big';
    cardBig.innerHTML = `<img src="${card.image}" alt="" onerror="this.outerHTML='<span>\uD83C\uDCCB</span>'">`;
    item.appendChild(cardBig);
    const info = document.createElement('div');
    info.className = 'browse-info-text';
    info.textContent = cardLabel(card);
    item.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'browse-btns';
    const safeLabel = cardLabel(card).replace(/'/g, "\\'");
    const safeName = victimName.replace(/'/g, "\\'");
    const safeKey = (card.deckKey || G.deckKey).replace(/'/g, "\\'");
    btns.innerHTML = `
      <button class="btn btn-sm btn-accent" onclick="oppHandTakeToHand('${pid}','${card.uid}','${card.image}','${safeKey}','${safeLabel}','${safeName}')">\u2192 My Hand</button>
      <button class="btn btn-sm btn-red" onclick="executeHandEffect('${pid}','${card.uid}','${card.image}','${safeKey}','force-discard','${safeLabel}','${safeName}')">Force Discard</button>
      <button class="btn btn-sm btn-ghost" onclick="executeHandEffect('${pid}','${card.uid}','${card.image}','${safeKey}','shuffle-to-deck','${safeLabel}','${safeName}')">→ Their Deck</button>`;
    item.appendChild(btns);
    body.appendChild(item);
  });
}

function oppHandTakeToHand(pid, cardUid, cardImage, cardDeckKey, cardName, victimName) {
  const roomData = getRoomData();
  if (!roomData || !roomData.players[pid]) { toast('Cannot find player'); return; }
  const player = roomData.players[pid];
  if (!player.handCards) { toast('Hand data not synced'); return; }
  const idx = player.handCards.findIndex(c => c.uid === cardUid);
  if (idx === -1) { toast('Card not found'); return; }
  player.handCards.splice(idx, 1);
  G.hand.push({ image: cardImage, uid: cardUid, deckKey: cardDeckKey });
  if (!roomData.reveals) roomData.reveals = [];
  roomData.reveals.push({ playerId: G.playerId, playerName: G.playerName, timestamp: Date.now(),
    action: 'force-take-from-hand', victimId: pid, victimName: victimName,
    cardUid: cardUid, cardImage: cardImage, cardName: cardName, cardDeckKey: cardDeckKey });
  if (roomData.reveals.length > 50) roomData.reveals = roomData.reveals.slice(-50);
  setRoomData(roomData);
  syncMyHand();
  updateAll();
  addLogEntry('You took \u201c' + cardName + '\u201d from ' + victimName + "'s hand", 'other');
  buildOppHandViewSheet(victimName, player.handCards, pid);
  toast('Card taken!');
}

// \u2550\u2550\u2550 END CARD EFFECTS \u2550\u2550\u2550

// ═══════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════

let _tt;

function toast(msg) {
  const t = document.getElementById('toast');
  t.innerHTML = msg;
  t.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.remove('show'), 1800);
}

// ═══════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════

buildEditionGrid();
