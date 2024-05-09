(function () {
  'use strict';

  let max = Math.max;
  let random = v => v ? (Math.random() * v)|0 : Math.random();

  /**
   * Creates a pseudo-random value generator. The seed must be an integer.
   *
   * Uses an optimized version of the Park-Miller PRNG.
   * http://www.firstpr.com.au/dsp/rand31/
   *
   *
   * See https://gist.github.com/blixt/f17b47c62508be59987b
   */

   /**
    * Changes: if no seed (or seed=0) is provided, use a random seed.
    */
  function Random(seed) {
    this._seed = seed ? seed % 2147483647 : random(2147483647);
    //console.log(`using initial random seed ${this._seed}`);
    if (this._seed <= 0) this._seed += 2147483646;
  }

  // custom addition because we need a way to know how to seed very exactly.
  Random.prototype.seed = function (v) {
    if (v) this._seed = v;
    return this._seed;
  };

  /**
   * Returns a pseudo-random value between 1 and 2^32 - 2.
   */
  Random.prototype.next = function () {
    return this.seed(this._seed * 16807 % 2147483647);
  };

  /**
   * Returns a pseudo-random floating point number in range [0, 1).
   */
  Random.prototype.nextFloat = function (opt_minOrMax, opt_max) {
    // We know that result of next() will be 1 to 2147483646 (inclusive).
    return (this.next() - 1) / 2147483646;
  };

  const playlog = {
      lines: [],
      prefix: () => `${Date.now()}: `,
      log: (text) => {
          if (typeof text !== "string") text = text.toString();
          text.split('\n').forEach(line => {
              playlog.lines.push(`${playlog.prefix()}${line}`);
          });
      },
      flush: () => {
          if (config.WRITE_GAME_LOG) {
              let text = playlog.lines.slice().join('\n');
              playlog.openTab(text);
          }
          playlog.lines = [];
      },
      openTab: (text) => {
          let a = document.createElement(`a`);
          a.target = `_blank`;
          a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
          a.style.display = `none`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
      }
  };

  /**
   * A class that encodes all the various "non-standard-play"
   * limit hands, e.g. limits with 14 tile hands that cannot
   * be parsed as four sets and a pair.
   */
  class LimitHands {

    /**
     * Check for thirteen orphans:
     *
     * The 1 and 9 of each suit, once; each wind
     * and dragon, once; a pairing tile for any.
     */
    hasThirteenOrphans(tiles) {
      let thirteen = [0,8,9,17,18,26,27,28,29,30,31,32,33];
      thirteen.forEach(t => {
        let pos = tiles.indexOf(t);
        if (pos>-1) tiles.splice(pos,1);
      });
      return (tiles.length === 1 && thirteen.indexOf(tiles[0])>-1);
    }

    /**
     * Check for nine gates:
     *
     * 1,1,1, 2,3,4,5,6,7,8, 9,9,9, and a
     * pairing tile for any. All same suit.
     */
    hasNineGates(tiles, lockedSize) {
      if (lockedSize > 2) return false;
      if (tiles.some(t => t>=27)) return false;
      let suit = (tiles[0]/9) | 0;
      if (tiles.some(t =>  ((t/9)|0) !== suit)) return false;
      let offset = suit * 9;
      let nine = [0,0,0, 1,2,3,4,5,6,7, 8,8,8].map(t => t+offset);
      nine.forEach(t => {
        let pos = tiles.indexOf(t);
        if (pos>-1) tiles.splice(pos,1);
      });
      return (tiles.length === 1 && offset < tiles[0] && tiles[0] < offset+8);
    }
  }

  /**
   * A special datastructure for housing the
   * faan/laak scoring conversion values.
   */
  class FaakLaakTable {
    constructor(no_point_score=0, limits) {
      this.no_point_score = no_point_score;
      this.limits = limits;
      this.generateConversionTable();
    }

    generateConversionTable() {
      let faan;
      this.table = {};
      let limits = this.limits;

      // base points:
      this.table[0] = this.no_point_score;
      for(faan=1; faan < limits[0]; faan++) this.table[faan] = 2**faan;

      // tiered limits:
      let laak = faan;
      for (let i=0, e=limits.length-1; i<e; i++) {
        let limit_s = limits[i];
        let limit_e = limits[i+1];
        for(let j=limit_s; j < limit_e; j++) this.table[j] = 2**laak;
        laak++;
      }
      this.table[limits.slice(-1)] = 2**laak;
    }

    get(points, selfdraw, limit) {
      let highest_limit = this.limits.slice(-1);
      if (limit || points >= highest_limit) return this.table[highest_limit];
      return this.table[points];
    }
  }

  /**
   * hash a tile requirement object to a compact string form.
   */
  function hash(set) {
    let s = `${set.type}`;
    if (set.subtype) { s = `${s}s${set.subtype}`; }
    if (set.type===Constants.PAIR || set.type===Constants.CHOW) { s = `${s}t${set.tile}`; }
    return s;
  }

  /**
   * unhash a tile requirement object from its compact string form.
   */
  function unhash$1(print, tile) {
    let re = /(\d+)(s(-?\d+))?(t(\d+))?/;
    let m = print.match(re);
    let type = parseInt(m[1]);
    let subtype = m[3] ? parseInt(m[3]) : undefined;
    let required = tile;
    if (type===Constants.CHOW) tile -= subtype;
    let obj = { required, type, subtype, tile };
    return obj;
  }

  /**
   * Refactor class to turn string sets into real sets.
   */
  class PatternSet {
    static from(hash) {
      return new PatternSet(unhash(hash));
    }

    static fromTiles(tiles, locked, concealed) {
      if (typeof tiles[0] !== "number") tiles = tiles.map((t) => t.getTileFace());
      let type = "";
      let tile = tiles[0];
      if (tiles.length === 4) type = "kong";
      if (tiles.length === 3) {
        if (tiles[1] === tile) type = "pung";
        else type = "chow";
      }
      if (tiles.length === 2) type = "pair";
      if (tiles.length === 1) type = "single";
      return new PatternSet(type, tile, locked, concealed);
    };


    constructor(type, tilenumber, locked, concealed) {
      if (tilenumber === undefined) {
        this.content = type;
      } else {
        this.type = type;
        this.tilenumber = tilenumber;
        this.locked = locked;
        // Note that the following value is a number to distinguish between:
        // - concealed kong declaration
        // - concealed pung part of a normal kong declaration
        this.concealed = concealed;
      }
    }

    getSetID() {
      let t = this.type;
      let asLocked = this.locked && !this.concealed;
      if (t === `kong`) return `4k-${this.tilenumber}-${asLocked ? `!` : ``}`;
      if (t === `pung`) return `3p-${this.tilenumber}-${asLocked ? `!` : ``}`;
      if (t === `chow`) return `3c-${this.tilenumber}-${asLocked ? `!` : ``}`;
      if (t === `pair`) return `2p-${this.tilenumber}-${asLocked ? `!` : ``}`;
      if (t === `single`) return `1s-${this.tilenumber}`;
      return "0n";
    }

    tiles() {
      let t = this.type,
        n = this.tilenumber;
      if (t === "kong") return [n, n, n, n];
      if (t === "pung") return [n, n, n];
      if (t === "chow") return [n, n + 1, n + 2];
      if (t === "pair") return [n, n];
      if (t === "single") return [n];
      return [];
    }

    size() {
      let t = this.type;
      if (t === "kong") return 4;
      if (t === "pung") return 3;
      if (t === "chow") return 3;
      if (t === "pair") return 2;
      if (t === "single") return 1;
      return 0;
    }

    equals(other) {
      return this.type === other.type && this.tilenumber === other.tilenumber;
    }

    // String parity
    split(...args) {
      return this.toString().split(...args);
    }
    indexOf(...args) {
      return this.toString().indexOf(...args);
    }
    valueOf() {
      return this.content ? this.content.valueOf() : this.getSetID();
    }
    toString() {
      return this.content ? this.content.toString() : this.getSetID();
    }
  }

  /**
   * An analysis class for working with collections
   * of "free" tiles in terms of what can be formed
   * with them, and which tiles would be needed to
   * turn incomplete sets into sets.
   */
  class Pattern {
    constructor(tiles=[]) {
      this.keys = [];
      this.tiles = {};
      tiles.slice().sort((a,b)=>a-b).forEach(v => {
        if (this.tiles[v] === undefined) {
          this.tiles[v] = 0;
        }
        this.tiles[v]++;
        this.keys.push(v);
      });
    }

    /**
     * a factory version of a copy constructor
     */
    copy() {
      let p = new Pattern([], this.canChow);
      p.keys = this.keys.slice();
      p.keys.forEach(k => (p.tiles[k] = this.tiles[k]));
      return p;
    }

    /**
     * Remove a set of tiles from this pattern. If this
     * causes the number of tiles for a specific tile
     * face to reach 0, remove that tile from the tile set.
     */
    remove(tiles) {
      if (!tiles.forEach) tiles = [tiles];
      tiles.forEach(t => {
        this.tiles[t]--;
        if (this.tiles[t] === 0) {
          delete this.tiles[t];
          this.keys = Object.keys(this.tiles).sort((a,b)=>a-b);
        }
      });
    }

    /**
     * utility function to get the suit for an (assumed suited) tile.
     */
    getSuit(tile) { return ((tile/9)|0); }

    /**
     * utility function for confirming a specific tile is of a specific suit.
     */
    matchSuit(tile, suit) { return this.getSuit(tile) === suit; }

    /**
     * This lets us know whether or not there are a entries for [tile+1]
     * and [tile+2] in this hand, which lets us make decisions around whether
     * chows are a valid play strategy or not.
     */
    getChowInformation(tile) {
      let suit = (tile / 9)|0;
      let t1 = this.tiles[tile + 1];
      if (t1 !== undefined && !this.matchSuit(tile + 1, suit)) t1 = undefined;
      let t2 = this.tiles[tile + 2];
      if (t2 !== undefined && !this.matchSuit(tile + 2, suit)) t2 = undefined;
      let t3 = this.tiles[tile + 3];
      if (t3 !== undefined && !this.matchSuit(tile + 3, suit)) t3 = undefined;
      return { t1, t2, t3, suit };
    }

    /**
     * mark tile as needed to form a set
     */
    markNeeded(results, tile, claimtype, subtype=undefined) {
      if (!results[tile]) results[tile] = [];
      let print = hash({type: claimtype, tile, subtype});
      if (results[tile].indexOf(print) === -1) results[tile].push(print);
    }

    /**
     * add a set's hashprint to the list of winpath results
     */
    markWin(results, tile, subtype) {
      this.markNeeded(results, tile, Constants.WIN, subtype);
    }

    /**
     * The recursion function for `expand`, this function checks whether
     * a given count combination of singles, pairs, and sets constitutes a
     * winning combination (e.g. 4 sets and a pair is a winning path, but
     * seven singles and two pairs definitely isn't!)
     */
    recurse(seen, chain, to_remove, results, singles, pairs, sets) {
      let downstream = this.copy();
      downstream.remove(to_remove);

      // Do we have tiles left that need analysis?
      if (downstream.keys.length > 0) {
        return downstream.runExpand(seen, chain, results, singles, pairs, sets);
      }

      // We do not. What's the conclusion for this chain?

      // four sets and a pair is totally a winning path.
      if (sets.length===4 && pairs.length===1 && singles.length===0) {
        if (!results.win) results.win = [];
        results.win.push({
          pair: pairs,
          sets
        });
      }

      // four sets and a single is one tile away from winning.
      else if (sets.length===4 && pairs.length===0 && singles.length===1) {
        this.markWin(results, singles[0], Constants.PAIR);
      }

      // three sets and two pairs are one tile away from winning.
      else if (sets.length===3 && pairs.length===2) {
        this.markWin(results, pairs[0], Constants.PUNG);
        this.markWin(results, pairs[1], Constants.PUNG);
      }

      // three sets, a pair, and two singles MIGHT be one tile away from winning.
      else if (sets.length===3 && pairs.length===1 && singles.length===2) {
        if (singles[1] < 27 && singles[0] + 1 === singles[1]) {
          let t1 = singles[0]-1, s1 = this.getSuit(t1),
              b0 = singles[0],   s2 = this.getSuit(b0),
              b1 = singles[1],   s3 = this.getSuit(b1),
              t2 = singles[1]+1, s4 = this.getSuit(t2);
          if(s1 === s2 && s1 === s3) this.markWin(results, t1, Constants.CHOW1);
          if(s4 === s2 && s4 === s3) this.markWin(results, t2, Constants.CHOW3);
        }
        else if (singles[1] < 27 && singles[1] === singles[0]+2) {
          let middle = singles[0] + 1;
          let s1 = this.getSuit(singles[0]);
          let s2 = this.getSuit(middle);
          let s3 = this.getSuit(singles[1]);
          if (s1===s3 && s1===s2) this.markWin(results, middle, Constants.CHOW2);
        }
      }

      // Everything else isn't really all that worth evaluating.

      // TODO: OR IS IT??
    }

    /**
     * Determine which set compositions are possible with the current
     * list of tiles. Specifically, which count combination of singles,
     * pairs, and sets can we make with these tiles?
     */
    runExpand(seen=[], paths=[], results=[], singles=[], pairs=[], sets=[]) {
      //console.log(`called with:`, seen, '- aggregated', pair, set, `- local tiles:`, this.tiles);

      if (!this.keys.length) {
        // It's possible the very first call is already for a complete,
        // and entirely locked, hand. In that case, return early:
        if (sets.length===4 && pairs.length===1 && singles.length===0) {
          if (!results.win) results.win = [];
          results.win.push({
            pair: pairs,
            sets
          });
        }
        return { results, paths };
      }

      // Otherwise, let's get determine-y:

      seen = seen.slice();
      let tile = (this.keys[0]|0); // remember: object keys are strings, we need to (int) them,
      seen.push(tile);

      let count = this.tiles[tile];
      let head = [];
      let toRemove = [];

      //console.debug(`evaluating tile`,tile);

      // If we're holding a kong, recurse with the set count increased by one,
      // which we do by adding this kong's hash print to the list of known sets.
      if (count>3) {
        head=[new PatternSet(`kong`, tile)];
        paths.push(head);
        toRemove = [tile, tile, tile, tile];
        this.recurse(seen, head, toRemove, results, singles, pairs, sets.concat(head));
      }

      // If we're (implied or only) holding a pung, also recurse with the set count increased by one.
      if (count>2) {
        head=[new PatternSet(`pung`, tile)];
        paths.push(head);
        toRemove = [tile, tile, tile];
        this.markNeeded(results, tile, Constants.KONG);
        this.recurse(seen, head, toRemove, results, singles, pairs, sets.concat(head));
      }

      // If we're (implied or only) holding a pair, also recurse with the pair count increased by one.
      if (count>1) {
        head=[new PatternSet(`pair`, tile)];
        paths.push(head);
        toRemove = [tile, tile];
        this.markNeeded(results, tile, Constants.PUNG);
        this.recurse(seen, head, toRemove, results, singles, pairs.concat([tile]), sets); // FIXME: why is this not concat(head)-able?
      }

      // And of course, the final recursion is for treating the tile as "just a singles".
      this.recurse(seen, paths, [tile], results, singles.concat([tile]), pairs, sets);

      // Now, if we're dealing with honour tiles, this is all we need to do.
      if (tile > 26) return { results, paths };

      // but if we're dealing with a suited number tile, we also need to check for chows.
      let {t1, t2, t3} = this.getChowInformation(tile);

      if (t1 || t2) {
        let suit = this.getSuit(tile);
        if (t1 && t2) {
          // we are holding a chow!
          head=[new PatternSet(`chow`, tile)];
          paths.push(head);
          toRemove = [tile, tile+1, tile+2];
          if (t3) {
            // Make sure that in {5,6,7,8}, the code knows that
            // 6 and 7 are both potentially useful tiles.
            this.markNeeded(results, tile+1, Constants.CHOW1);
            this.markNeeded(results, tile+2, Constants.CHOW3);
          }
          if (seen.indexOf(tile-1) === -1) {
            // We might also be one tile away from having a chow(1), if -1 is in the same suit.
            if (this.matchSuit(tile-1,suit)) this.markNeeded(results, tile-1, Constants.CHOW1);
          }
          this.recurse(seen, head, toRemove, results, singles, pairs, sets.concat(head));
        }
        else if (t1) {
          // We might be one tile away from having a chow(3), if +2 is in the same suit.
          if (this.matchSuit(tile+2,suit)) this.markNeeded(results, tile+2, Constants.CHOW3);
          // We might also be one tile away from having a chow(1), if -1 is in the same suit.
          if (seen.indexOf(tile-1) === -1) {
            // We might also be one tile away from having a chow(1), if -1 is in the same suit.
            if (this.matchSuit(tile-1,suit)) this.markNeeded(results, tile-1, Constants.CHOW1);
          }
          this.recurse(seen, paths, [tile, tile+1], results, singles, pairs, sets);
        }
        else {
          // One tile away from having a chow, and because it's the
          // middle tile, we know that it's the correct suit already.
          this.markNeeded(results, tile+1, Constants.CHOW2);
          this.recurse(seen, paths, [tile, tile+2], results, singles, pairs, sets);
        }
      }

      return { results, paths };
    }

    // Convenience function, so calling code doesn't need to know about
    // empty array instantiations for path/results/single
    expand(pair=[], set=[]) {
      return this.copy().runExpand(
        [], // seen
        [], // paths
        [], // results
        [], // singles
        pair,
        set
      );
    }
  }

  /**
   * This function uses the Pattern class to determine which tiles
   * a player might be interested in, to form valid hands. And,
   * if they already have a winning hand, how many interpretations
   * of the tiles involved there might be.
   */
  function tilesNeeded(tiles, locked=[]) {
    // console.debug('tilesNeeded:', tiles, locked);
    let p = new Pattern(tiles);

    // Transform the "locked tiles" listing to
    // a form that the rest of the code understands.
    locked = convertToPatternSets(locked);

    // Extract the pair, if there is one.
    let pair = [];
    locked.some((set,pos) => {
      if (set.type === 'pair') {
        pair.push(set);
        return locked.splice(pos,1);
      }
    });

    // Then run a pattern expansion!
    let {results, paths} = p.expand(pair.map(s => s.tilenumber), locked); // TODO: this should not need mapping

    // Is this a winning hand?
    let winpaths = (results.win || []).map(result => {
      let p = pair[0];
      let rpair = new PatternSet('pair', result.pair[0]);
      return [ (p && p.equals(rpair)) ? p : rpair, ...result.sets ];
    });
    let winner = (winpaths.length > 0);

    // Is this a waiting hand?
    delete results.win;
    let lookout = results;
    let waiting = !winner && lookout.some(list => list.some(type => type.indexOf('32')===0));

    // What are the various "compositions" in this hand?
    paths = paths.map(path => unroll(path));
    let composed = getUniqueCompositions(paths, );
    let to_complete = getStillNeeded(locked, composed);

    // And that's all the work we need to do.
    return { lookout, waiting, composed, to_complete, winner, winpaths};
  }

  /**
   * A helper function for converting HTML tile arrays into PatternSet objects.
   */
  function convertToPatternSets(locked) {
    return locked.map(set => {
      let numbered = set.map(t => t.getTileFace ? t.getTileFace() : t).sort();
      return PatternSet.fromTiles(numbered, true, set.concealed);
    }).filter(v => v);
  }


  /**
   * Convert the list of all possible pathing combinations
   * into a concise list of unique compositional paths.
   */
  function getUniqueCompositions(paths) {
    // (1) Remove full duplicates
    let composed = [];

    paths.forEach(path => path.forEach(part => {
      if (composed.some(e => e===part)) return;
      composed.push(part);
    }));

    composed.sort((a,b) => a.length - b.length);

    // And then (2) reduce the 'graph' because something like
    // this...
    //
    //   0: Array [ "2p-2", "2p-17" ]
    //   1: Array(3) [ "2p-2", "3c-5", "2p-17" ]
    //   2: Array [ "2p-17" ]
    //   3: Array [ "3c-5", "2p-17"]
    //
    // ... is really just a single chain (1) because all the
    // others are contained by that chain.
    //
    // The real solution to this whole filter/reduce business
    // is a change to Pattern, of course, so that it generates
    // only the maximum path, with splits only when needed.

    let filtered = [];

    for(let i=0, e=composed.length; i<e; i++) {
      let allFound = false;
      let list = composed[i];

      for (let j=i+1; j<e; j++) {
        let other = composed[j];
        allFound = list.every(part => other.find(e => e.equals(part)));
        if (allFound) break;
      }

      if (!allFound) filtered.push(list);
    }

    return filtered;
  }


  /**
   * Determine how many pairs/sets a compositional
   * path still needs to be a winning composition.
   */
  function getStillNeeded(locked, composed) {
    let pcount = 1, scount = 4;

    if (locked.length > 0) {
      locked.forEach(set => {
        if (set.size()===2) pcount--;
        else scount--;
      });
    }

    let to_complete = [];

    composed.forEach( (composition, pos) => {
      let p = pcount, s = scount, list = [];

      composition.forEach(set => {
        if (set.size()===2) p--;
        else s--;
      });

      if (p>0) list.push(Constants.PAIR);
      while (s-- > 0) list.push(Constants.SET);
      to_complete[pos] = list;
    });

    return to_complete;
  }

  /**
   * The generic ruleset object that specific
   * rulesets can extend off of.
   */
  class Ruleset {

    // helper functions
    getWindTile(wind) { return 27 + wind }
    ownFlower(tile, windTile) { return tile - 34 === windTile - 27 }
    ownSeason(tile, windTile) { return tile - 38 === windTile - 27 }
    allFlowers(bonus) { return [34, 35, 36, 37].every(t => bonus.indexOf(t) > -1); }
    allSeasons(bonus) { return [38, 39, 40, 41].every(t => bonus.indexOf(t) > -1); }

    constructor(
      scoretype,
      player_start_score,
      limit,
      points_for_winning,
      no_point_score,
      losers_settle_scores,
      east_doubles_up,
      selfdraw_pays_double,
      discard_pays_double,
      reverse_wind_direction,
      pass_on_east_win,
    ) {
      this.scoretype = scoretype;
      this.limits = new LimitHands();
      // Base values
      this.player_start_score = player_start_score;
      this.limit = limit;
      this.points_for_winning = points_for_winning;
      this.no_point_score = no_point_score;
      // Ruleset flags
      this.losers_settle_scores = losers_settle_scores;
      this.east_doubles_up = east_doubles_up;
      this.selfdraw_pays_double = selfdraw_pays_double;
      this.discard_pays_double = discard_pays_double;
      this.reverse_wind_direction = reverse_wind_direction;
      this.pass_on_east_win = pass_on_east_win;
      // do we need a faan/laak table?
      if (scoretype === Ruleset.FAAN_LAAK) {
        this.limit = limit[0];
        this.faan_laak_limits = limit;
        this.setupFaanLaakTable(no_point_score, limit);
      }
    }

    /**
     * This is its own function, so that subclasses can override it with different values.
     */
    setupFaanLaakTable(no_point_score, limits) {
      this.faan_laak_table = new FaakLaakTable(no_point_score, limits);
    }

    /**
     * calculate the actual number of points awarded under point/double rules.
     */
    getPointsDoubleLimit() {
      return this.limit;
    }

    /**
     * calculate the actual number of points awarded under point/double rules.
     */
    getFaanLaakLimit(selfdraw) {
      return this.faan_laak_table.get(0, selfdraw, true);
    }

    /**
     * perform standard Faan conversion
     */
    convertFaan(points, selfdraw, limit) {
      return this.faan_laak_table.get(points, selfdraw, limit);
    }

    /**
     * perform points/doubles conversion
     */
    convertPoints(points, doubles) {
      if (!points && this.no_point_score) points = this.no_point_score;
      return points * (2 ** doubles);
    }

    /**
     * Limits may require faan/laak computation
     */
    getLimitPoints(selfdraw) {
      if (this.scoretype === Ruleset.POINTS_DOUBLES) return this.getPointsDoubleLimit();
      if (this.scoretype === Ruleset.FAAN_LAAK) return this.getFaanLaakLimit(selfdraw);
      console.error('unknown scoring type');
      return 0;
    }

    /**
     * The base ruleset covers two classic limit hands.
     */
    checkForLimit(allTiles, lockedSize) {
      if (allTiles.length < 14) return;
      const tiles = () => allTiles.slice().map(t => t|0).sort();
      if (this.limits.hasThirteenOrphans(tiles())) return `Thirteen orphans`;
      if (this.limits.hasNineGates(tiles(), lockedSize)) return `Nine gates`;
    }

    /**
     * Generate a limit hand object
     */
    generateLimitObject(limit, selfdraw) {
      return {
        limit: limit,
        log: [`Limit hand: ${limit}`],
        score: 0,
        doubles: 0,
        total: this.getLimitPoints(selfdraw)
      };
    }

    /**
     * Turn basic tilescores into score adjustments, by running
     * the "how much does the winner get" and "how much do the
     * losers end up paying" calculations.
     */
    settleScores(scores, winningplayer, eastplayer, discardpid) {
      console.debug(`%cSettling payment`, `color: red`);

      let adjustments = [0, 0, 0, 0];
      let eastWinFactor = (winningplayer === eastplayer) ? 2 : 1;
      let wscore = scores[winningplayer].total;
      let selfdraw = (discardpid===false);

      console.debug(`winning score: ${wscore}, double east? ${this.east_doubles_up}`);

      for (let i = 0; i < scores.length; i++) {
        if (i === winningplayer) continue;

        // every non-winner pays the winner.
        if (i !== winningplayer) {
          let difference = wscore;
          if (this.east_doubles_up) {
            let paysAsEast = (i === eastplayer) ? 2 : 1;
            difference *= Math.max(eastWinFactor, paysAsEast);
          }
          if ((this.discard_pays_double && i===discardpid) || (this.selfdraw_pays_double && selfdraw)) {
            difference *= 2;
          }
          adjustments[winningplayer] += difference;
          console.debug(`${winningplayer} gets ${difference} from ${i}`);
          adjustments[i] -= difference;
          console.debug(`${i} pays ${difference} to ${winningplayer}`);
        }

        if (!this.losers_settle_scores) continue;

        // If losers should settle their scores amongst
        // themselves, make that happen right here:
        for (let j = i + 1; j < scores.length; j++) {
          if (j === winningplayer) continue;

          let difference = (scores[i].total - scores[j].total);
          if (this.east_doubles_up) {
            let paysAsEast = (i === eastplayer) ? 2 : 1;
            difference *= paysAsEast;
          }
          console.debug(`${i} gets ${difference} from ${j}`);
          adjustments[i] += difference;
          console.debug(`${j} pays ${difference} to ${i}`);
          adjustments[j] -= difference;
        }
      }

      if (this.east_doubles_up) {
        if (winningplayer === eastplayer) scores[eastplayer].log.push(`Player won as East`);
        else scores[eastplayer].log.push(`Player lost as East`);
      }

      return adjustments;
    }

    // implemented by subclasses
    getPairValue() { return false; }
    getChowValue() { return false; }
    getPungValue() { return false; }
    getKongValue() { return false; }

    /**
     * ...docs go here...
     */
    _tile_score(set, windTile, windOfTheRoundTile) {
      let locked = set.locked;
      let concealed = set.concealed;
      let tiles = set.tiles();
      let tile = tiles[0];
      let names = config.TILE_NAMES;

      if (tiles.length === 2) return this.getPairValue(tile, locked, concealed, names, windTile, windOfTheRoundTile);
      if (tiles.length === 3) {
        if (tile !== tiles[1]) return this.getChowValue(tile, locked, concealed, names, windTile, windOfTheRoundTile);
        else return this.getPungValue(tile, locked, concealed, names, windTile, windOfTheRoundTile);
      }
      if (tiles.length === 4) return this.getKongValue(tile, locked, concealed, names, windTile, windOfTheRoundTile);
    }

    // implemented by subclasses
    checkBonusTilePoints(bonus, windTile, names, result) {}
    checkHandPatterns(scorePattern, windTile, windOfTheRoundTile, tilesLeft, result) {}
    checkWinnerHandPatterns(scorePattern, winset, selfdraw, windTile, windOfTheRoundTile, tilesLeft, scoreObject) {}

    // Aggregate all the points for individual sets into a single score object
    aggregateScorePattern(scorePattern, windTile, windOfTheRoundTile) {
      return scorePattern
        .map(set => this._tile_score(set, windTile, windOfTheRoundTile))
        .filter(v => v)
        .reduce((t, v) => {
          t.score += v.score;
          t.doubles += (v.doubles||0);
          t.log = t.log.concat(v.log);
          return t;
        },{ score: 0, doubles: 0, log: [] });
    }

    /**
     * ...docs go here...
     */
    getTileScore(scorePattern, windTile, windOfTheRoundTile, bonus, winset, winner=false, selfdraw=false, selftile=false, robbed=false, tilesLeft) {
      let names = config.TILE_NAMES;
      let result = this.aggregateScorePattern(scorePattern, windTile, windOfTheRoundTile);
      result.wind = windTile;
      result.wotr = windOfTheRoundTile;

      this.checkBonusTilePoints(bonus, windTile, names, result);
      this.checkHandPatterns(scorePattern, windTile, windOfTheRoundTile, tilesLeft, result);
      if (winner) {
        if (this.points_for_winning > 0) {
          result.score += this.points_for_winning;
          result.log.push(`${this.points_for_winning} for winning`);
        }
        this.checkWinnerHandPatterns(scorePattern, winset, selfdraw, selftile, robbed, windTile, windOfTheRoundTile, tilesLeft, result);
      }

      if (result.limit) {
        result.score = this.limit;
        result.doubles = 0;
        result.total = this.limit;
        result.log.push(`Limit hand: ${result.limit}`);
      } else {
        result.total = 0;

        if (this.scoretype === Ruleset.POINTS_DOUBLES) {
          result.total = this.convertPoints(result.score, result.doubles);
          if (result.total > this.limit) {
            result.log.push(`Score limited from ${result.total} to ${this.limit}`);
            result.total = this.limit;
          }
        }

        if (this.scoretype === Ruleset.FAAN_LAAK) {
          result.total = this.convertFaan(result.score, selfdraw);
        }
      }

      return result;
    }

    /**
     * All possible flags and values necessary for performing scoring, used in checkWinnerHandPatterns
     */
    getState(scorePattern, winset, selfdraw, selftile, robbed, windTile, windOfTheRoundTile, tilesLeft) {
      // We start with some assumptions, and we'll invalidate them as we see more sets.
      let state = {
        chowhand: true,
        punghand: true,

        onesuit: true,
        honours: false,
        allhonours: true,
        terminals: true,
        allterminals: true,

        outonPair: true,
        pairTile: -1,
        majorPair: false,
        dragonPair: false,
        windPair: false,
        ownWindPair: false,
        wotrPair: false,

        ownWindPung: false,
        wotrPung: false,
        ownWindKong: false,
        wotrKong: false,

        chowCount: 0,
        windPungCount: 0,
        windKongCount: 0,
        dragonPungCount: 0,
        dragonKongCount: 0,
        concealedCount: 0,
        kongCount: 0,
        suit: false,
        selfdraw: selfdraw,
        robbed: robbed,
        lastTile: (tilesLeft<=0)
      };

      // classic limit hands
      state.allGreen = scorePattern.every(set => set.tiles().every(t => [1,2,3,5,7,31].indexOf(t) > -1));

      let tiles, tile, tilesuit;
      scorePattern.forEach(set => {
        if (!set.locked || set.concealed) state.concealedCount++;

        tiles = set.tiles();
        tile = tiles[0];
        tilesuit = (tile / 9) | 0;

        if (tile < 27) {
          if (state.suit === false) state.suit = tilesuit;
          else if (state.suit !== tilesuit) state.onesuit = false;
          if (tiles.some(t => (t%9) !== 0 && (t%9) !== 8)) {
            state.terminals = false;
            state.allterminals = false;
          }
          state.allhonours = false;
        } else {
          state.honours = true;
          state.allterminals = false;
        }

        if (tiles.length === 2) {
          if (winset) {
            let wintiles = winset.tiles();
            state.outonPair = (wintiles.length===2 && wintiles[0]===tiles[0]);
            state.pairTile = wintiles[0];
          }
          else if (!winset && selfdraw && tiles[0] === selftile) {
            state.outonPair = true;
            state.pairTile = selftile;
          }
          else {
            state.outonPair = false;

            if (tile > 26 && tile < 31) {
              state.windPair = true;
              state.majorPair = true;
            }
            if (tile > 30) {
              state.dragonPair = true;
              state.majorPair = true;
            }
            if (tile === windTile) {
              state.ownWindPair = true;
              state.majorPair = true;
            }
            if (tile === windOfTheRoundTile) {
              state.wotrPair = true;
              state.majorPair = true;
            }
          }
        }

        if (tiles.length === 3) {
          if (tile === tiles[1]) {
            if (tile > 26 && tile < 31) {
              state.windPungCount++;
              if (tile === windTile) state.ownWindPung = true;
              if (tile === windOfTheRoundTile) state.wotrPung = true;
            }
            if (tile > 30) state.dragonPungCount++;
            state.chowhand = false;
          } else {
            state.chowCount++;
            state.punghand = false;
          }
        }

        if (tiles.length === 4) {
          state.kongCount++;
          if (tile > 26 && tile < 31) {
            state.windKongCount++; // implies pung
            if (tile === windTile) state.ownWindKong = true; // implies windPunt
            if (tile === windOfTheRoundTile) state.wotrKong = true; // implies wotrKong
          }
          if (tile > 30) state.dragonKongCount++; // implies pung
          state.chowhand = false;
        }
      });

      return state;
    }

    /**
     * Scoring tiles means first seeing how many different
     * things can be formed with the not-revelead tiles,
     * and then for each of those things, calculate the
     * total hand score by adding in the locked tiles.
     *
     * Whichever combination of pattersn scores highest
     * is the score the player will be assigned.
     */
    scoreTiles(disclosure, id, windOfTheRound, tilesLeft) {
      console.debug("SCORE TILES", id, disclosure, windOfTheRound, tilesLeft);

      // Let's get the administrative data:
      let winner = disclosure.winner;
      let selfdraw = disclosure.selfdraw;
      let selftile = disclosure.selftile ? disclosure.selftile.getTileFace() : false;
      let robbed = disclosure.robbed;
      let tiles = disclosure.concealed;
      let locked = disclosure.locked;
      let bonus = disclosure.bonus;
      let winset = false;
      let windTile = this.getWindTile(disclosure.wind);
      let windOfTheRoundTile = this.getWindTile(windOfTheRound);
      let allTiles = tiles.slice();

      // Move kong tile concealments out of the tile datasets
      // and into the sets themselves, instead.
      locked = locked.map(set => {
        if (set.length === 4) {
          let ccount = set.reduce((tally,t) => tally + (t.isConcealed() ? 1 : 0), 0);
          if (ccount >= 3) set.concealed = `${ccount}`;
        }
        return set;
      });

      // TODO: SWITCH OVER THE ABOVE CODE TO PatternSet RATHER THAN PLAIN ARRAYS

      // And then let's see what our tile-examining
      // algorithm has to say about the tiles we have.
      let tileInformation = tilesNeeded(tiles, locked);
      let openCompositions = tileInformation.composed;

      // Then, flatten the locked sets from tile elements
      // to simple numerical arrays, but with the set
      // properties (locked/concealed) preserved:
      locked = locked.map(set => {
        let newset = PatternSet.fromTiles(set, true, set.concealed);
        allTiles.push(...set);
        if (!!set[0].isWinningTile()) winset = newset;
        return newset;
      });

      // If this is the winner, though, then we _know_ there is at
      // least one winning path for this person to have won.
      if (winner) {
        // first check for non-standard-pattern limit hands
        let limit = this.checkForLimit(allTiles, locked.reduce((t,s) => t + s.length, 0));
        if (limit) {
          config.log('limit hand');
          return this.generateLimitObject(limit, selfdraw);
        }

        // no limit: proceed to score hand based on normal win paths.
        openCompositions = tileInformation.winpaths;
      } else {
        // Do we even bother figuring out what the not-winner has?
        if (!this.losers_settle_scores) {
          config.log('losers do not require score computation');
          return { score: 0, doubles: 0, log: [], total: 0 };
        }

        // If there is nothing to be formed with the tiles in hand,
        // then we need to create an empty path, so that we at
        // least still compute score based on just the locked tiles.
        if(openCompositions.length === 0) openCompositions.push([]);
      }

      // Run through each possible interpetation of in-hand
      // tiles, and see how much they would score, based on
      // the getTileScore() function up above.
      let possibleScores = openCompositions.map(chain => {
        return this.getTileScore(
          chain.concat(winner ? [] : locked),
          windTile,
          windOfTheRoundTile,
          bonus,
          winset,
          winner,
          selfdraw,
          selftile,
          robbed,
          tilesLeft);
      });

      config.log('possible scores:', possibleScores);

      // And then make sure we award each player the highest score they're elligible for.
      let finalScore = possibleScores.sort( (a,b) => { a = a.total; b = b.total; return a - b; }).slice(-1)[0];
      config.log('final score:', finalScore);

      if (!finalScore) {
        disclosure.locked = disclosure.locked.map(set => set.map(tile => tile.values ? tile.values.tile : tile));
        //console.log(disclosure);
        //console.log(possibleScores);
        throw new Error("no score could be computed");
      }

      return finalScore;
    }

     /**
     * Determine how this hand could be improved
     */
    _determineImprovement(concealed, locked, composed, to_complete, tiletracker) {
      return [];
    }

    /**
     * ...docs go here...
     */
    determineImprovement(player, tilesLeft, winner=false) {
      let concealed = player.getTileFaces();
      let locked = player.locked;
      let data = this.scoreTiles({
        winner,
        wind: player.wind,
        concealed,
        locked,
        bonus: player.bonus
      }, player.id, player.windOfTheRound, tilesLeft);

      let { composed, to_complete } = player.tilesNeeded();
      data.improvement = this._determineImprovement(concealed, locked, composed, to_complete, player.tracker);
      return data;
    }
  }

  Ruleset.FAAN_LAAK = Symbol();
  Ruleset.POINTS_DOUBLES = Symbol();

  /**
   * Set up ruleset registration/fetching by name. Note that
   * we add spaces in between camelcasing to make things
   * easier to work with: `Ruleset.getRuleset("Chinese Classical")`
   * is just friendlier for human code maintainers/editors.
   */
  (() => {
    let rulesets = {};

    Ruleset.register = function(RulesetClass) {
      let naturalName = RulesetClass.name.replace(/([a-z])([A-Z])/g, (_, b, c) => `${b} ${c}`);
      rulesets[naturalName] = new RulesetClass();
    };

    Ruleset.getRuleset = name => rulesets[name];

    Ruleset.getRulesetNames = () => Object.keys(rulesets);
  })();

  /**
   * Cantonese rules.
   */
  class Cantonese extends Ruleset {

    constructor() {
      super(
        Ruleset.FAAN_LAAK,
        500,         // start score
        [5, 7, 10],  // tiered limits
        0,           // points for winning
        0.5,         // no-point hand score
        false,       // losers do not pay each other
        false,       // east does not doubles up
        true,        // selfdraw wins pay double
        true,        // discarding player pays double
        true,        // reverse wind direction
        true         // deal passes when east wins
      );
    }

    /**
     * What are considered point-scoring pungs in this ruleset?
     */
    getPungValue(tile, locked, concealed, names, windTile, windOfTheRoundTile) {
      let prefix = (locked && !concealed) ? "" : "concealed ";

      if (tile > 26) {
        if (tile > 30) {
          return { score: 1, log: [`1 faan for ${prefix}pung of dragons (${names[tile]})`] };
        }

        let scoreObject = { score: 0, log: [] };
        if (tile === windTile) {
          scoreObject.score += 1;
          scoreObject.log.push(`1 faan for ${prefix}pung of player's own wind (${names[tile]})`);
        }
        if (tile === windOfTheRoundTile) {
          scoreObject.score += 1;
          scoreObject.log.push(`1 faan for ${prefix}pung of wind of the round (${names[tile]})`);
        }
        return scoreObject;
      }
    }

    /**
     * What are considered point-scoring kongs in this ruleset?
     */
    getKongValue(tile, locked, concealed, names, windTile, windOfTheRoundTile) {
      let prefix = (locked && !concealed) ? "" : "concealed ";

      if (tile > 26) {
        if (tile > 30) {
          return { score: 1, log: [`1 faan for ${prefix}kong of dragons (${names[tile]})`] };
        }

        let scoreObject = { score: 0, log: [] };
        if (tile === windTile) {
          scoreObject.score += 1;
          scoreObject.log.push(`1 faan for ${prefix}kong of player's own wind (${names[tile]})`);
        }
        if (tile === windOfTheRoundTile) {
          scoreObject.score += 1;
          scoreObject.log.push(`1 faan for ${prefix}kong of wind of the round (${names[tile]})`);
        }
        return scoreObject;
      }
    }

    /**
     * There are special points that any player can get
     * at the end of the hand. Calculate those here:
     */
    checkHandPatterns(scorePattern, windTile, windOfTheRoundTile, tilesLeft, scoreObject) {
      // this ruleset only awards points for little three dragons.
      let r, g, w;

      scorePattern.forEach(set => {
        let tile = set[0];
        if (tile===31) g = set.length;
        if (tile===32) r = set.length;
        if (tile===33) w = set.length;
      });

      if (r + g + w >= 8 && (r===2 || g===2 || w===2)) {
        scoreObject.score += 4;
        scoreObject.log.push(`4 faan for little three dragons`);
      }
    }

    /**
     * There are special points that you can only get
     * by winning the hand. Calculate those here:
     */
    checkWinnerHandPatterns(scorePattern, winset, selfdraw, selftile, robbed, windTile, windOfTheRoundTile, tilesLeft, scoreObject) {
      let names = config.TILE_NAMES;
      let suits = config.SUIT_NAMES;

      let state = this.getState(scorePattern, winset, selfdraw, selftile, robbed, windTile, windOfTheRoundTile, tilesLeft);

      if (state.selfdraw) {
        scoreObject.score += 1;
        scoreObject.log.push(`1 faan for self-drawn win (${names[selftile]})`);
      }

      if (state.robbed) {
        scoreObject.score += 1;
        scoreObject.log.push(`1 faan for robbing a kong (${names[winset[0]]})`);
      }

      if (state.chowhand && !state.majorPair) {
        scoreObject.score += 1;
        scoreObject.log.push(`1 faan for chow hand`);
      }

      if (state.onesuit) {
        if (state.honours) {
          scoreObject.score += 1;
          scoreObject.log.push(`1 faan for one suit (${suits[state.suit]}) and honours hand`);
        } else {
          scoreObject.score += 5;
          scoreObject.log.push(`5 faan for clean one suit hand (${suits[state.suit]})`);
        }
      }

      if (state.allterminals) {
        scoreObject.limit = `all terminals hand`;
      }

      if (state.allhonours) {
        scoreObject.limit = `all honours hand`;
      }

      if (state.punghand) {
        scoreObject.score += 3;
        scoreObject.log.push(`3 faan for all pung hand`);
      }

      if (state.dragonPungCount + state.dragonKongCount === 3) {
        scoreObject.limit = `Three great scholars (pung or kong of each dragon)`;
      }

      if (state.windPungCount + state.windKongCount === 3 && state.windPair) {
        scoreObject.limit = `Little four winds (pung or kong of three wind, pair of last wind)`;
      }

      if (state.windPungCount + state.windKongCount === 4) {
        scoreObject.limit = `Big four winds (pung or kong of each wind)`;
      }

      if (state.concealedCount === 5) {
        scoreObject.score += 1;
        scoreObject.log.push(`1 faan for fully concealed hand`);
      }

      // no point hand?
      if (scoreObject.score === 0) {
        scoreObject.log.push(`${this.no_point_score} for no-point hand`);
      }
    }

    /**
     * Award points based on bonus tiles.
     */
    checkBonusTilePoints(bonus, windTile, names, result) {
      let hasOwnFlower = false;
      let hasOwnSeason = false;

      bonus.forEach(tile => {
        if (this.ownFlower(tile, windTile)) hasOwnFlower = true;
        if (this.ownSeason(tile, windTile)) hasOwnSeason = true;
      });

      if (bonus.length === 0) {
        result.score += 1;
        result.log.push(`1 faan for no flowers or seasons`);
      }

      if (hasOwnFlower) {
        result.score += 1;
        result.log.push(`1 faan for own flower and season`);
      }

      if (hasOwnSeason)  {
        result.score += 1;
        result.log.push(`1 faan for own flower and season`);
      }

      if (this.allFlowers(bonus)) {
        result.score += 1;
        result.log.push(`1 faan for having all flowers`);
      }

      if (this.allSeasons(bonus)) {
        result.score += 1;
        result.log.push(`1 faan for having all seasons`);
      }
    }
  }

  // register as a ruleset
  Ruleset.register(Cantonese);

  /**
   * Chinese Classical rules.
   */
  class ChineseClassical extends Ruleset {

    constructor() {
      super(
        Ruleset.POINTS_DOUBLES,
        2000,  // start score
        1000,  // single limit
        10,    // 10 points for winning
        false, // no-point hand does not exist in this ruleset
        true,  // losers pay each other
        true,  // east doubles up
        false, // selfdraw wins do not pay double
        false, // discarding player does not pay double
        true,  // reverse wind direction
        false  // deal does not pass when east wins
      );
    }

    /**
     * What are considered point-scoring pairs in this ruleset?
     */
    getPairValue(tile, locked, concealed, names, windTile, windOfTheRoundTile) {
      if (tile > 30) return {
        score: 2,
        log: [ `2 for pair of dragons (${names[tile]})` ]
      };

      if (tile === windTile) return {
        score: 2,
        log: [ `2 for pair of own wind (${names[tile]})` ]
      };

      if (tile === windOfTheRoundTile) return {
        score: 2,
        log: [ `2 for pair of wind of the round (${names[tile]})` ]
      };
    }

    /**
     * What are considered point-scoring pungs in this ruleset,
     * and do those incur any doubles?
     */
    getPungValue(tile, locked, concealed, names, windTile, windOfTheRoundTile) {
      let prefix = (locked && !concealed) ? "" : "concealed ";
      let value = 0;

      if (tile>30) {
        value = locked ? 4 : 8;
        return {
          score: value,
          doubles: 1,
          log: [
            `${value} for ${prefix}pung of dragons (${names[tile]})`,
            `1 double for pung of dragons (${names[tile]})`
          ]
        };
      }

      if (tile > 26) {
        value = locked ? 4 : 8;
        let scoreObject = {
          score: value,
          doubles: 0,
          log: [ `${value} for ${prefix}pung of winds (${names[tile]})` ]
        };
        if (tile === windTile) {
          scoreObject.doubles += 1;
          scoreObject.log.push(`1 double for pung of player's own wind (${names[tile]})`);
        }
        if (tile === windOfTheRoundTile) {
          scoreObject.doubles += 1;
          scoreObject.log.push(`1 double for pung of wind of the round (${names[tile]})`);
        }
        return scoreObject;
      }

      if (tile < 27) {
        let type;
        if (tile % 9 === 0 || tile % 9 === 8) {
          type = `terminals`;
          value = locked ? 4 : 8;
        } else {
          type = `simple`;
          value = locked ? 2 : 4;
        }
        return {
          score: value,
          log: [ `${value} for ${prefix}pung of ${type} (${names[tile]})` ]
        };
      }
    }

    /**
     * What are considered point-scoring kongs in this ruleset,
     * and do those incur any doubles?
     */
    getKongValue(tile, locked, concealed, names, windTile, windOfTheRoundTile) {
      let value = 0;

      // Is this a melded kong (locked, not concealed), a
      // claimed kong (locked, concealed=3 for pung), or
      // a self-drawn kong (locked, concealed=4 for kong)?
      let prefix = ``;
      let ccount = concealed;
      if (!ccount) prefix = `melded `;
      else if (ccount === 3) prefix = `claimed `;
      else if (ccount === 4) prefix = `concealed `;

      if (tile>30) {
        value = (locked || ccount===3) ? 16 : 32;      return {
          score: value,
          doubles: 1,
          log: [
            `${value} for ${prefix}kong of dragons (${names[tile]})`,
            `1 double for kong of dragons (${names[tile]})`
          ]
        };
      }

      if (tile > 26) {
        value = (locked || ccount===3) ? 16 : 32;
        let scoreObject = {
          score: value,
          doubles: 0,
          log: [ `${value} for ${prefix}kong of winds (${names[tile]})` ]
        };
        if (tile === windTile) {
          scoreObject.doubles += 1;
          scoreObject.log.push(`1 double for kong of player's own wind (${names[tile]})`);
        }
        if (tile === windOfTheRoundTile) {
          scoreObject.doubles += 1;
          scoreObject.log.push(`1 double for kong of wind of the round (${names[tile]})`);
        }
        return scoreObject;
      }

      if (tile < 27) {
        let type;
        if (tile % 9 === 0 || tile % 9 === 8) {
          type = `terminals`;
          value = (locked || ccount===3) ? 16 : 32;
        } else {
          type = `simple`;
          value = (locked || ccount===3) ? 8 : 16;
        }
        return {
          score: value,
          log: [ `${value} for ${prefix}kong of ${type} (${names[tile]})` ]
        };
      }
    }

    /**
     * There are special points and doubles that any player
     * can get at the end of the hand. Calculate those here:
     */
    checkHandPatterns(scorePattern, windTile, windOfTheRoundTile, tilesLeft, scoreObject) {
      // this ruleset only awards points for little three dragons.
      let r, g, w;

      scorePattern.forEach(set => {
        let tile = set[0];
        if (tile===31) g = set.length;
        if (tile===32) r = set.length;
        if (tile===33) w = set.length;
      });

      if (r + g + w >= 8 && (r===2 || g===2 || w===2)) {
        scoreObject.doubles += 1;
        scoreObject.log.push(`1 double for little three dragons`);
      }
    }

    /**
     * There are special points and doubles that you can only
     * get by winning the hand. Calculate those here:
     */
    checkWinnerHandPatterns(scorePattern, winset, selfdraw, selftile, robbed, windTile, windOfTheRoundTile, tilesLeft, scoreObject) {
      let names = config.TILE_NAMES;
      let suits = config.SUIT_NAMES;
      let state = this.getState(scorePattern, winset, selfdraw, selftile, robbed, windTile, windOfTheRoundTile, tilesLeft);

      if (state.selfdraw) {
        scoreObject.score += 2;
        scoreObject.log.push(`2 for self-drawn win (${names[selftile]})`);
      }

      if (state.robbed) {
        scoreObject.doubles += 1;
        scoreObject.log.push(`1 double for robbing a kong (${names[winset[0]]})`);
      }

      if (state.outonPair) {
        scoreObject.score += 2;
        scoreObject.log.push(`2 for winning on a pair (${names[state.pairTile]})`);
      }

      if (state.outonPair && state.majorPair) {
        scoreObject.score += 2;
        scoreObject.log.push(`2 for winning on a major pair`);
      }

      if (state.chowhand && !state.majorPair) {
        scoreObject.doubles += 1;
        scoreObject.log.push(`1 double for chow hand`);
      }

      if (state.onesuit) {
        if (state.honours) {
          scoreObject.doubles += 1;
          scoreObject.log.push(
            `1 double for one suit (${suits[state.suit]}) and honours hand`
          );
        } else {
          scoreObject.doubles += 3;
          scoreObject.log.push(`3 doubles for clean one suit hand (${suits[state.suit]})`);
        }
      }

      if (state.allterminals) {
        scoreObject.limit = `all terminals hand`;
      }

      if (state.allhonours) {
        scoreObject.limit = `all honours hand`;
      }

      if (state.terminals && state.honours) {
        scoreObject.doubles += 1;
        scoreObject.log.push(`1 double for terminals an honours hand`);
      }

      if (state.punghand) {
        scoreObject.doubles += 1;
        scoreObject.log.push(`1 double for all pung hand`);
      }

      if (state.kongCount === 4) {
        scoreObject.limit = `All kong hand`;
      }

      if (state.dragonPungCount + state.dragonKongCount === 3) {
        scoreObject.limit = `Three great scholars (pung or kong of each dragon)`;
      }

      if (state.windPungCount + state.windKongCount === 3 && state.windPair) {
        scoreObject.limit = `Little four winds (pung or kong of three wind, pair of last wind)`;
      }

      if (state.windPungCount + state.windKongCount === 4) {
        scoreObject.limit = `Big four winds (pung or kong of each wind)`;
      }

      if (state.concealedCount === 5) {
        scoreObject.doubles += 1;
        scoreObject.log.push(`1 double for fully concealed hand`);
      }

      if (state.concealedCount === 5 && state.punghand) {
        scoreObject.limit = `Fully concealed pung hand`;
      }

      if (state.lastTile) {
        scoreObject.doubles += 1;
        if (selfdraw) {
          scoreObject.log.push(
            `1 double for winning with the last available wall tile`
          );
        } else {
          scoreObject.log.push(`1 double for winning with the last discard`);
        }
      }

      if (state.allGreen) {
        scoreObject.limit = `"All Green" (bamboos 2, 3, 4, 6, 8 and/or green dragons)`;
      }
    }

    /**
     * Award points based on bonus tiles. A flat 4 points per
     * bonus, but Chinese classical also awards some doubles
     * based on having specific flowers/seasons.
     */
    checkBonusTilePoints(bonus, windTile, names, result) {
      let hasOwnFlower = false;
      let hasOwnSeason = false;

      bonus.forEach(tile => {
        result.score += 4;
        result.log.push(`4 for bonus tile (${names[tile]})`);
        if (this.ownFlower(tile, windTile)) hasOwnFlower = true;
        if (this.ownSeason(tile, windTile)) hasOwnSeason = true;
      });

      if (hasOwnFlower && hasOwnSeason) {
        result.doubles += 1;
        result.log.push(`1 double for own flower and season`);
      }

      if (this.allFlowers(bonus)) {
        result.doubles += 2;
        result.log.push(`1 double for having all flowers`);
      }

      if (this.allSeasons(bonus)) {
        result.doubles += 2;
        result.log.push(`1 double for having all seasons`);
      }
    }
  }

  // register as a ruleset
  Ruleset.register(ChineseClassical);

  const noop = () => {};
  const __console_debug = console.debug.bind(console);

  const updateCurrentConfig = () => {
    const fromStorage = JSON.parse(localStorage.getItem("mahjongConfig") || "{}");
    for (var key in DEFAULT_CONFIG) {
      if (!(key in fromStorage)) {
        fromStorage[key] = DEFAULT_CONFIG[key];
      }
    }
    globalThis.currentConfig = fromStorage;

    for (const [key, value] of Object.entries(globalThis.currentConfig)) {
      if (value === "true") globalThis.currentConfig[key] = true;
      if (value === "false") globalThis.currentConfig[key] = false;
      if (value == parseFloat(value)) globalThis.currentConfig[key] = parseFloat(value); // note: == rather than ===
    }

    for (var key in globalThis.currentConfig) {
      config[key] = globalThis.currentConfig[key];
    }
  }

  const DEFAULT_CONFIG = {
    // This flag needs no explanation
    DEBUG: false,

    // This flag also needs no explanation
    USE_SOUND: true,

    // The pseudo-random number generator seed.
    // This value lets us "replay" problematic
    // games to find out where things go wrong.
    SEED: 0,

    // The ruleset to play with.
    RULES: `Chinese Classical`,

    // This determines whether you get asked to
    // choose normal vs. automated play when you
    // load the page.
    PLAY_IMMEDIATELY: false,

    // Do not pause games when the page loses focus
    PAUSE_ON_BLUR: true,

    // Debugging around drawn hands requires
    // being able to force a draw
    FORCE_DRAW: false,

    // This determines whether we bypass the
    // separation of concern and force bots to
    // update the player's ui, even though they
    // normally would have no way to access it.
    FORCE_OPEN_BOT_PLAY: false,

    // Highlight discarded tiles if the human
    // player can claim them for something.
    SHOW_CLAIM_SUGGESTION: true,

    // Work play suggestions as determined by
    // the bot that underpins the human player
    // into the game UI.
    SHOW_BOT_SUGGESTION: true,

    // How likely are bots to go for chicken
    // hands, rather than for hands worth points?
    //
    // Set this to 1 to turn all bots into chickens!
    //
    // Set this to 0 to turn off chicken hands
    // (except when a bot goes into panic mode).
    //
    // Defaults to a roughly 1:72 chance to
    // chicken. Note that once panic mode sets in,
    // this value doubles with each check.
    BOT_CHICKEN_THRESHOLD: 0.0008,

    // The number of milliseconds the game
    // allows players to lay claim to a discard.
    // Bots need nowhere near this much, but
    // humans tend to need more than a few ms!
    CLAIM_INTERVAL: 5000,

    // The number of milliseconds between
    // players taking their turn.
    PLAY_INTERVAL: 100,

    // The number of milliseconds pause
    // between playing "hands".
    HAND_INTERVAL: 3000,

    // The number of milliseconds that
    // the bots will wait before putting
    // in their claim for a discard.
    // If this is 0, humans feel like they
    // are playing bots. Which they are.
    // But if this is a few hundred ms,
    // game play "Feel" more natural.
    BOT_DELAY_BEFORE_DISCARD_ENDS: 300,

    // When autoplay is enabled, how fast
    // should the bots play, for people to
    // be able to enjoy what's happening?
    BOT_PLAY_DELAY: 50,

    // Turning on wall hacks will set the wall
    // to very specific walls for debugging
    // purposes. This option simple fixes the
    // wall to a pattern on reset() so you can't
    // play a game if you use this. You just
    // get to debug a very specific situation.
    WALL_HACK: "",

    // Write the game log to disk, or to a new
    // tab as a text file.
    WRITE_GAME_LOG: false,
  };

  globalThis.currentConfig = {};

  // Constants used during play, for determining
  // claim types on discarded tiles.
  const CLAIM$1 = {
    IGNORE: 0,
    PAIR: 1,
    CHOW: 2,
    CHOW1: 4, // first tile in pattern: X**
    CHOW2: 5, // middle tile in pattern: *X*
    CHOW3: 6, // last time in pattern: **X
    PUNG: 8,
    KONG: 16,
    SET: 30, // masks 0b.0001.1110
    WIN: 32,
  };

  // This is a legacy list and needs to just be
  // removed from the game code, with "CLAIM"
  // getting renamed to something more general.
  const Constants = {
    PAIR: CLAIM$1.PAIR,
    CHOW: CLAIM$1.CHOW,
    CHOW1: CLAIM$1.CHOW1,
    CHOW2: CLAIM$1.CHOW2,
    CHOW3: CLAIM$1.CHOW3,
    PUNG: CLAIM$1.PUNG,
    KONG: CLAIM$1.KONG,
    SET: CLAIM$1.SET,
    WIN: CLAIM$1.WIN,
  };

  // Tile names...
  const TILE_NAMES = {
    0: "bamboo 1",
    1: "bamboo 2",
    2: "bamboo 3",
    3: "bamboo 4",
    4: "bamboo 5",
    5: "bamboo 6",
    6: "bamboo 7",
    7: "bamboo 8",
    8: "bamboo 9",
    9: "characters 1",
    10: "characters 2",
    11: "characters 3",
    12: "characters 4",
    13: "characters 5",
    14: "characters 6",
    15: "characters 7",
    16: "characters 8",
    17: "characters 9",
    18: "dots 1",
    19: "dots 2",
    20: "dots 3",
    21: "dots 4",
    22: "dots 5",
    23: "dots 6",
    24: "dots 7",
    25: "dots 8",
    26: "dots 9",
    27: "east",
    28: "south",
    29: "west",
    30: "north",
    31: "green dragon",
    32: "red dragon",
    33: "white dragon",
    34: "flower 1",
    35: "flower 2",
    36: "flower 3",
    37: "flower 4",
    38: "season 1",
    39: "season 2",
    40: "season 3",
    41: "season 4",
  };

  const TILE_GLYPHS = {
    0: "b1", // '🀐',
    1: "b2", // '🀑',
    2: "b3", // '🀒',
    3: "b4", // '🀓',
    4: "b5", // '🀔',
    5: "b6", // '🀕',
    6: "b7", // '🀖',
    7: "b8", // '🀗',
    8: "b9", // '🀘',
    9: "c1", // '🀇',
    10: "c2", // '🀈',
    11: "c3", // '🀉',
    12: "c4", // '🀊',
    13: "c5", // '🀋',
    14: "c6", // '🀌',
    15: "c7", // '🀍',
    16: "c8", // '🀎',
    17: "c9", // '🀏',
    18: "d1", // '🀙',
    19: "d2", // '🀚',
    20: "d3", // '🀛',
    21: "d4", // '🀜',
    22: "d5", // '🀝',
    23: "d6", // '🀞',
    24: "d7", // '🀟',
    25: "d8", // '🀠',
    26: "d9", // '🀡',
    27: "E", // '🀀',
    28: "S", // '🀁',
    29: "W", // '🀂',
    30: "N", // '🀃',
    31: "F", // '🀅',
    32: "C", // '🀄',
    33: "P", // '🀆',
    34: "f1", // '🀢',
    35: "f2", // '🀣',
    36: "f3", // '🀤',
    37: "f4", // '🀥',
    38: "s1", // '🀦',
    39: "s2", // '🀧',
    40: "s3", // '🀨',
    41: "s4", // '🀩'
  };

  const SUIT_NAMES = {
    0: "bamboo",
    1: "characters",
    2: "dots",
    3: "winds",
    4: "dragons",
    5: "bonus",
  };

  // And then rest of the configuration.
  const config = Object.assign(
    {
      set: (opt) => {
        Object.keys(opt).forEach((key) => {
          let value = opt[key];
          if (typeof config[key] !== "undefined") {
            config[key] = value;
            if (key === `DEBUG`) {
              if (value) {
                //console.log("activating");
                console.debug = __console_debug;
              } else {
                //console.log("deactivating");
                console.debug = noop;
              }
            }
          }
        });
      },

      // which settings can the user update?
      DEFAULT_CONFIG,

      // The pseudo-random number generator used by
      // any code that needs to randomise data.
      PRNG: new Random(globalThis.currentConfig.SEED),
      DEBUG: globalThis.currentConfig.DEBUG,
      log: noop,
      flushLog: noop,

      // For debugging purposes, if we're messing
      // with which hand/draw it is, we need to
      // probably also peg the PRNG seed.
      START_OVERRIDE_SEED: 0,

      // For debugging purposes, we can tell
      // the game to effectively start on a
      // hand other than hand 1.
      START_ON_HAND: 0,

      // For debugging purposes, we can tell
      // the game to effectively pause play
      // at the end of the following "hand".
      // A value of 0 means "don't pause".
      PAUSE_ON_HAND: 0,

      // For debugging purposes, we prespecify
      // the number of draws.
      START_ON_DRAWS: 0,

      // For debugging purposes, we can tell
      // the game to effectively pause play
      // at the end of the following "draw".
      // A value of 0 means "don't pause".
      PAUSE_ON_DRAW: 0,

      // For debugging purposes, we can tell
      // the game to pause play after a specific
      // tile getting dealt during a hand.
      // A value of 0 means "don't pause".
      PAUSE_ON_PLAY: 0,

      // This setting determines which type of play
      // is initiated if PLAY_IMMEDIATELY is true
      BOT_PLAY: false,

      // This value determines how long bots will
      // "wait" before discarding a tile. This is
      // a purely cosmetic UX thing, where humans
      // enjoy a game more if it doesn't feel like
      // they're playing against perfect machines.
      // We're weird that way.
      ARTIFICIAL_BOT_DELAY: 300,

      // Determine whether we award points based on
      // the losers paying the winner, or the losers
      // also paying each other.
      //
      // Note that this is purely a fallback value,
      // and rulesets should specify this instead.
      LOSERS_SETTLE_SCORES: true,

      // See above
      CLAIM: CLAIM$1,

      // See above
      Constants,

      // See above
      TILE_NAMES,
      TILE_GLYPHS,
      SUIT_NAMES,

      // A conversion function for turning computer
      // chow differences into claim types. This will
      // probably be migrated to somewhere else soon.
      convertSubtypeToClaim: (diff) => {
        if (diff === -1) return CLAIM$1.CHOW3;
        if (diff === 1) return CLAIM$1.CHOW2;
        if (diff === 2) return CLAIM$1.CHOW1;
        return diff;
      },
    },
    globalThis.currentConfig
  );

  updateCurrentConfig();

  // bind console.debug correctly.
  config.set({ DEBUG: globalThis.currentConfig.DEBUG });

  config.log = playlog.log;
  config.flushLog = playlog.flush;

  class GameTile extends HTMLElement {
    constructor(tile) {
      super();
      tile = tile ?? this.getAttribute(`tile`) ?? -1;
      this.values = { tile };
      this.setAttribute(`tile`, this.values.tile);
      this.setAttribute(`title`, TILE_NAMES[tile]);
      this.setAttribute(`alt`, TILE_NAMES[tile]);
    }

    static get observedAttributes() {
      return [
        `bonus`,
        `tile`,
        `locked`,
        `locknum`,
        `hidden`,
        `concealed`,
        `supplement`,
      ];
    }

    attributeChangedCallback(attr, oldVal, newVal) {
      if (oldVal === newVal) return;
      this.onChange(attr, newVal);
    }

    onChange(attributeName, attributeValue) {
      // Is this a boolean value?
      let asBool = new Boolean(attributeValue).toString();
      if (attributeValue == asBool) {
        return (this.values[attributeName] = asBool);
      }
      // Maybe it's a number?
      let asInt = parseInt(attributeValue);
      if (attributeValue == asInt) {
        return (this.values[attributeName] = asInt);
      }
      let asFloat = parseFloat(attributeValue);
      if (attributeValue == asFloat) {
        return (this.values[attributeName] = asFloat);
      }
      // Okay fine, it's a string.
      this.values[attributeName] = attributeValue;
    }

    // TODO: refactor these two functions out of existence
    mark(...labels) {
      labels.forEach((label) => this.classList.add(label));
    }
    unmark(...labels) {
      labels.forEach((label) => this.classList.remove(label));
    }
    // TODO: refactor these two functions out of existence

    getFrom() {
      return this.values.from;
    }
    setFrom(pid) {
      this.setAttribute(`from`, pid);
    }

    setTitle(title = false) {
      if (title) {
        this.setAttribute(`title`, title);
      } else {
        this.removeAttribute(`title`);
      }
    }

    hide() {
      this.setAttribute(`hidden`, true);
    }
    isHidden() {
      return this.values.hidden;
    }
    reveal() {
      this.removeAttribute(`hidden`);
    }

    conceal() {
      this.setAttribute(`concealed`, true);
    }
    isConcealed() {
      return this.values.concealed;
    }
    unconceal() {
      this.removeAttribute(`concealed`);
    }

    winning() {
      this.setAttribute(`winning`, true);
    }
    isWinningTile() {
      return this.values.winning;
    }

    lock(locknum) {
      this.setAttribute(`locked`, true);
      if (locknum) {
        this.setAttribute(`locknum`, locknum);
      }
    }

    meld() {
      this.setAttribute(`meld`, true);
    }
    isLocked() {
      return this.values.locked;
    }
    getLockNumber() {
      return this.values.locknum;
    }
    unlock() {
      this.removeAttribute(`locked`);
      this.removeAttribute(`locknum`);
    }

    bonus() {
      this.setAttribute(`bonus`, true);
      this.lock();
    }
    isBonus() {
      return this.values.bonus;
    }

    supplement() {
      this.setAttribute(`supplement`, true);
    }
    isSupplement() {
      return this.values.supplement;
    }

    setTileFace(tile) {
      this.setAttribute(`tile`, tile);
    }
    getTileFace() {
      return this.values.tile;
    }
    getTileSuit() {
      let num = this.getTileFace();
      if (num < 9) return 0;
      if (num < 18) return 1;
      if (num < 27) return 2;
      if (num < 30) return 3;
      return 4;
    }

    valueOf() {
      return this.values.tile;
    }

    toString() {
      return `GameTile(${this.values.tile})`;
    }
  }

  globalThis.customElements.define(`game-tile`, GameTile);

  /**
   * Register all tiles
   */
  function declare(label, tilenumber) {
    globalThis.customElements.define(
      label,
      class extends GameTile {
        constructor() {
          super(tilenumber);
        }
      }
    );
  }

  const numeral = [
    `one`,
    `two`,
    `three`,
    `four`,
    `five`,
    `six`,
    `seven`,
    `eight`,
    `nine`,
  ];
  let tilenumber = 0;
  [`bamboo`, `characters`, `dots`].forEach((suit) =>
    numeral.forEach((number) => declare(`${suit}-${number}`, tilenumber++))
  );
  declare(`east-wind`, 27);
  declare(`south-wind`, 28);
  declare(`west-wind`, 29);
  declare(`north-wind`, 30);
  declare(`green-dragon`, 31);
  declare(`red-dragon`, 32);
  declare(`white-dragon`, 33);
  tilenumber = 34;
  [`flower`, `season`].forEach((b) =>
    numeral
      .slice(0, 4)
      .forEach((number) => declare(`${b}-${number}`, tilenumber++))
  );

  /**
   * Create a <span data-tile=`...`></span> element
   * from a specified tile number. Also, because it's
   * such a frequent need, this adds a `getTileFace()`
   * function to the span itself.
   */
  const create = (tileNumber, hidden) => {
    let span;

    if (typeof process !== `undefined`) {
      span = new GameTile(tileNumber);
    } else {
      let GameTile = customElements.get(`game-tile`);
      span = new GameTile(tileNumber);
    }

    if (tileNumber < 34) ; else span.bonus();

    return span;
  };

  /**
   * We all know what this does.
   */
  Array.prototype.last = function last() {
    return this[this.length - 1];
  };

  /**
   * More intentional Array prototype overloading.
   */
  Array.prototype.asyncAll = async function asyncAll(fn) {
    return await Promise.all(
      this.map(
        (e) =>
          new Promise((resolve) => {
            fn(e);
            resolve();
          })
      )
    );
  };

  const __roll_sort = (a, b) => (a < b ? -1 : b > a ? 1 : 0);

  /**
   * A tree to list-of-paths unrolling function.
   */
  function unroll(list, seen = [], result = []) {
    list = list.slice();
    seen.push(list.shift());
    if (!list.length) {
      seen.sort(__roll_sort);
      let print = seen.toString();
      let found = result.some((sofar) => sofar.toString() === print);
      if (!found) result.push(seen);
    } else list.forEach((tail) => unroll(tail, seen.slice(), result));
    return result;
  }

  /**
   * This file contains a bunch of "virtual key" definitions,
   * that specify which key codes map to a specific virtual
   * interpretation. For example, the "left" action can be
   * represented by both the left cursor key, but also the
   * 'a' key, for those who are used to WASD controls.
   */

  const VK_LEFT = {
    "37": true, // left cursor
    "65": true  // 'a' key
  };

  const VK_RIGHT = {
    "39": true, // right cursor
    "68": true  // 'd' key
  };

  const VK_UP = {
    "38": true, // up cursor
    "87": true  // 'w' key
  };

  const VK_DOWN = {
    "40": true, // down cursor
    "83": true  // 's' key
  };

  const VK_START = {
    "36": true // home
  };

  const VK_END = {
    "35": true // end
  };

  const VK_SIGNAL = {
    "13": true, // enter
    "32": true  // space
  };

  /**
   * In addition to the key maps, we also need to
   * make sure we put in the signal lock to prevent
   * OS/application-level key-repeat from incorrectly
   * triggering events:
   */

  let vk_signal_lock = false;

  function lock_vk_signal() {
    vk_signal_lock = true;
    document.addEventListener('keyup', unlock_vk_signal);
  }
  function unlock_vk_signal(evt) {
    let code = evt.keyCode;
    if (VK_UP[code] || VK_SIGNAL[code]) {
      vk_signal_lock = false;
      document.removeEventListener('keyup', unlock_vk_signal);
    }
  }

  class OptionsDialog {
    constructor(modal) {
        this.modal = modal;
    }

    /**
     * This modal offers a label and a set of button choices
     * to pick from. Buttons can be navigated with the
     * cursor keys for one handed play.
     */
    show(label, options, resolve, cancel)  {
      let panel = this.modal.makePanel();
      if (options.fixed) panel.fixed = true;
    panel.innerHTML = `<h1>${label}</h1>`;

      let bid = 0;
      let btns = [];

      options.filter(v=>v).forEach(data => {
        if (Object.keys(data).length===0) {
          return panel.appendChild(document.createElement('br'));
        }

        if (data.heading) {
          let heading = document.createElement('h1');
          heading.textContent = data.heading;
          return panel.appendChild(heading);
        }

        if (data.description) {
          let description = document.createElement('p');
          if (data.align) description.classList.add(data.align);
          description.textContent = data.description;
          return panel.appendChild(description);
        }

        let btn = document.createElement("button");
        btn.textContent = data.label;

        btn.addEventListener("click", e => {
          e.stopPropagation();
          if (!data.back) this.modal.close([{ object:this.modal.gameBoard, evntName:'focus', handler: panel.gainFocus }]);
          resolve(data.value);
        });

        btn.addEventListener("keydown", e => {
          e.stopPropagation();
          let code = e.keyCode;
          let willBeHandled = (VK_UP[code] || VK_DOWN[code] || VK_START[code] || VK_END[code]);
          if (!willBeHandled) return;
          e.preventDefault();
          if (VK_UP[code]) bid = (bid===0) ? btns.length - 1 : bid - 1;
          if (VK_DOWN[code]) bid = (bid===btns.length - 1) ? 0 : bid + 1;
          if (VK_START[code]) bid = 0;
          if (VK_END[code]) bid = btns.length - 1;
          btns[bid].focus();
        });

        panel.appendChild(btn);
      });

      if (cancel) {
        let handleKey = evt => {
          if (evt.keyCode === 27) {
            evt.preventDefault();
            this.modal.close([
              { object:document, evntName:'focus', handler: panel.gainFocus },
              { object:this.modal.gameBoard, evntName:'keydown', handler: handleKey },
            ]);
            cancel();
          }
        };
        this.modal.gameBoard.addEventListener('keydown', handleKey);
      }

      btns = panel.querySelectorAll(`button`);
      panel.gainFocus = () => btns[bid].focus();
      document.addEventListener('focus', panel.gainFocus);
      panel.addEventListener('click', panel.gainFocus);
      panel.addEventListener('touchstart', panel.gainFocus, {passive: true});
      panel.gainFocus();
    }
  }

  /**
   * We need a way to debug play with specific walls, so...
   */
  const WallHack = {
    hacks: {
      self_drawn_win_clean: [
        1,1,1,   2,2,2,   3,3,3,   4,4,4,      5, // p0
        16,16,16,17,17,17,18,18,18,19,19,19,  27, // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        5 // p0 win
      ],

      self_drawn_win: [
        1,1,1,  23,23,23,  2,3,4,   24,24,24,  5, // p0
        16,16,16,17,17,17,18,18,18,19,19,19,  27, // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        5 // p0 win
      ],

      form_melded_kong_off_initial: [
        0,3,6, 9,21,15, 18,21,24, 12,3,9, 13,    // p0
        1,1,1, 2,2,2, 12,19,21, 4,4,4, 0,        // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 25, // p3
        5, // p0 discard
        5, // p1 discards 21, p0 pungs, discard 24
        9, // p1 not a win, discards
        13, // p2 not a win, discards
        12, // p3 not a win, discard
        21, // p0 can now meld a kong
      ],

      kong_in_initial_deal: [
        1,1,1,     2,2,2,     3,3,3,     4,4,4,4, // p0
        16,16,16,17,17,17,18,18,18,19,19,19,   5, // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        5, // p0 supplement
        5  // p0 win
      ],

      kong_from_first_discard: [
        1,1,1,   2,2,2,   3,3,3,   4,4,4,      5, // p0
        16,16,16,17,17,17,18,18,18,19,19,19,   4, // p1
        11,11,11,12,12,12,13,13,13,14,20,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        16, // p1 kong
        5   // p0 win
      ],

      robbing_a_kong: [
        1,1,1,   2,2,2,   3,3,3,   4,4,    22,23, // p0
        16,16,16,17,17,17,18,18,18,14,14,14,  15, // p1
        11,11,11,12,12,12,13,13,13,24,24,24,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        5,  // p0 discard
        24, // p1 kong
        // p0 can win by robbing this kong.
      ],

      robbing_a_selfdrawn_kong: [
        1,1,1,   2,2,2,   3,3,3,   4,4,    22,23, // p0
        16,16,16,17,17,17,18,18,18,24,24,24,   4, // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        5,  // p0 discard
        24, // p1 kong
        // p0 can win by robbing this kong.
      ],

      melded_kong: [
        1,1,1,   2,2,2,   3,3,3,   4,5,    28,28, // p0
        16,16,16,17,17,17,18,18,18,19,19,19,   28, // p1
        11,11,11,12,12,12,13,13,13,14,20,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        30, // gets discarded by p0
        27,  // discard by p1, pung by p0, discard 4
        30, // gets discarded by p1
        30, // gets discarded by p2
        30, // gets discarded by p3
        28, // melded kong for p0
      ],

      chow_by_player_1: [
        1,1,1,   2,2,2,   3,3,3,   4,4,4,      5, // p0
        16,16,16,17,17,17,20,20,20, 23,24,26,  5, // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  26, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        25 // chow for p1
      ],

      all_bonus_to_player: [
        34,35,36,37,38,39,40,41,                  // p0 bonus tiles
        1,1,24,2,2,26,3,3,28,4,4,30,5,            // p0
        16,16,16,17,17,17,18,18,18,19,19,19,   5, // p0
        11,11,11,12,12,12,13,13,13,14,14,14,  26, // p0
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p0
      ],

      thirteen_orphans: [
        0,8,9,17,18,26,27,28,29,30,31,32,33,    // p0
        16,16,16,17,17,17,18,18,18,19,19,19,5,  // p1
        11,11,11,12,12,12,13,13,13,14,14,14,26, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,10,             // p3
        27 // p0 win
      ],

      all_green: [
        1,2,3,   2,2,2,   5,5,5,   7,7,7,     31, // p0
        16,16,16,17,17,17,18,18,18,19,19,19,   5, // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  26, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        31 // p0 win (pair)
      ],

      nine_gates: [
        0,0,0, 1,2,3,4,5,6,7, 8,8,8,              // p0
        16,16,16,17,17,17,18,18,18,19,19,19,  5,  // p1
        11,11,11,12,12,12,13,13,13,14,14,14,  26, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        3 // p0 win
      ],

      little_three_dragons: [
        1,1,1,  23,23,23,  2,3,4,  24,24,24,   5, // p0
        31,31,31,32,32,32,33,33,18,19,19,19,  27, // p1, pung of green, pung of red, pair of white
        11,11,11,12,12,12,13,13,13,14,14,14,  15, // p2
        6,6,6,7,7,7,8,8,8,9,9,9,              10, // p3
        5 // p0 win
      ],

      chow_for_player_0: [
        0,3,6, 9,24,25, 18,21,24, 12,3,9, 13,    // p0
        1,1,1, 2,2,2, 12,19,21, 4,4,4, 0,        // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 25, // p3
        5, // p0 discard
        5, // p1 discards 21
        5, // p2 discards 5
        23, // p3 discards 14
      ],

      '5_6_7_plus_5': [
        0,3,6, 9,14,15, 22,23,24,30, 3,9, 13,    // p0
        1,1,1, 2,2,2, 12,19,21, 4,4,4, 0,        // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 26, // p3
        5, // p0 discard
        5, // p1 discards
        5, // p2 discards
        22, // p3 discards
      ],

      '5_6_7_plus_6': [
        0,3,6, 9,14,15, 22,23,24,30, 3,9, 13,    // p0
        1,1,1, 2,2,2, 12,19,21, 4,4,4, 0,        // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 26, // p3
        5, // p0 discard
        5, // p1 discards
        5, // p2 discards
        23, // p3 discards
      ],

      '5_6_7_plus_7': [
        0,3,6, 9,14,15, 22,23,24,30, 3,9, 13,    // p0
        1,1,1, 2,2,2, 12,19,21, 4,4,4, 0,        // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 26, // p3
        5, // p0 discard
        5, // p1 discards
        5, // p2 discards
        24, // p3 discards
      ],

      '5_6_7_8_plus_6': [
        0,3,6, 9,14,15, 22,23,24,25, 3,9, 13,    // p0
        1,1,1, 2,2,2, 12,19,21, 4,4,4, 0,        // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 26, // p3
        5, // p0 discard
        5, // p1 discards 21
        5, // p2 discards 5
        23, // p3 discards 14
      ],

      pung_chow_conflict: [
        0,3,6, 9,14,15, 22,24,25, 3,9,13, 32 ,   // p0
        1,1,1, 2,2,2, 12,19,21, 23,23, 0,4,      // p1
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 26, // p3
        5, // p0 discard
        5, // p1 discards
        5, // p2 discards
        23, // p3 discards
      ],
      cantonese_chicken_hand: [
        1,1,1, 2,2,2, 6,7,8, 23,23, 9,9,         // p1
        3,3,21, 21,14,15, 22,24,25, 3,9,13, 32 , // p0
        7,7,7, 8,8,8, 10,10,10, 11,11,11, 0,     // p2
        16,16,16, 17,17,17, 20,20,20, 6,6,6, 26, // p3
        36, // p0 bonus tile
        5,5,5,15,15,
        1, // p0 selfdrawn win
      ],
    },

    set(wall, tiles) {
      tiles = tiles.slice();

      // If we're wall hacking, we want to ensure that the
      // PRNG is seeded with a known value. If there is a
      // config object as element [0], use its seed value,
      // use that. If not, seed it with the value 1.
      if (typeof tiles[0] === "object") {
        let conf = tiles.splice(0,1)[0];
        config.PRNG.seed(conf.seed || 1);
      } else config.PRNG.seed(1);

      let base = wall.getBase();
      tiles.forEach(tile => base.splice(base.indexOf(tile),1));
      wall.tiles = tiles.concat(wall.shuffle(base));
    }
  };

  class SettingsModal {
    constructor(modal) {
      this.modal = modal;
    }

    show() {
      let panel = this.modal.makePanel(`settings`);
      panel.innerHTML = `
      <h3>Change the game settings</h3>
      <p>
        The follow settings change how the game works, but while
        the first three options are related to playing the game,
        all the other options are primarily intended for debugging.
      </p>
    `;
      const options = this.getOptions();
      const form = this.modal.buildPanelContent(options, true);
      form.setAttribute("name", "settings");
      form.setAttribute("action", "index.html");
      form.setAttribute("method", "GET");
      this.addFormControls(panel, form, options);
      this.modal.addFooter(panel, "Closing without saving");
    }

    addFormControls(panel, form, options) {
      const table = form.querySelector(`table`);
      let row = document.createElement(`tr`);
      row.classList.add(`spacer-1`);
      row.innerHTML = `
      <td>
        <input id="reset" type="reset" value="Reset to default settings">
      </td>
      <td>
        <input id="ok" type="submit" value="Play using these settings">
      </td>
    `;
      table.appendChild(row);

      form.addEventListener(`submit`, (evt) => {
        evt.preventDefault();
        let mahjongConfig = {};
        options.forEach((entry) => {
          if (!entry.key) return;
          let value = entry.value;
          if (entry.value === "true") value = true;
          if (entry.value === "false") value = false;
          mahjongConfig[entry.key.toUpperCase()] = value;
        });
        localStorage.setItem("mahjongConfig", JSON.stringify(mahjongConfig));
        updateCurrentConfig();
        document.getElementById("okButton").click();
      });

      let ok = table.querySelector(`#ok`);
      panel.gainFocus = () => ok.focus();

      let reset = table.querySelector(`#reset`);
      reset.addEventListener("click", (evt) => {
        localStorage.setItem("mahjongConfig", JSON.stringify(DEFAULT_CONFIG));
        updateCurrentConfig();
        document.getElementById("okButton").click();
      });
    }

    getOptions() {
      const disabled = globalThis.currentGame !== undefined;
      const options = [
        {
          label: `Rules`,
          key: `rules`,
          options: [...Ruleset.getRulesetNames()],
          disabled,
        },
        {
          // basic boolean flags:
        },
        {
          label: `🀄 Always show everyone's tiles`,
          key: `force_open_bot_play`,
          toggle: true,
          disabled,
        },
        {
          label: `✨ Highlight claimable discards`,
          key: `show_claim_suggestion`,
          toggle: true,
        },
        {
          label: `💬 Show bot play suggestions`,
          key: `show_bot_suggestion`,
          toggle: true,
        },
        {
          // additional boolean flags:
        },
        {
          label: `🎵 Play sounds`,
          key: `use_sound`,
          toggle: true,
        },
        {
          label: `🟢 Start play immediately`,
          key: `play_immediately`,
          toggle: true,
        },
        {
          label: `⏸️ Pause game unless focused`,
          key: `pause_on_blur`,
          toggle: true,
          disabled,
        },
        {
          label: `💻 Turn on debug mode`,
          key: `debug`,
          toggle: true,
        },
        {
          label: `❌ Pretend previous round was a draw`,
          key: `force_draw`,
          toggle: true,
          debug_only: true,
        },
        {
          label: `📃 Generate game log after play`,
          key: `write_game_log`,
          toggle: true,
          debug_only: true,
        },
        {
          // numerical values:
        },
        {
          label: `Set game PRNG seed`,
          key: `seed`,
          debug_only: true,
        },
        {
          label: `Bot quick play threshold`,
          key: `bot_chicken_threshold`,
          debug_only: true,
        },
        {
          label: `Delay (in ms) between player turns`,
          key: `play_interval`,
        },
        {
          label: `Delay (in ms) before starting next hand`,
          key: `hand_interval`,
        },
        {
          label: `Delay (in ms) for bots reacting to things`,
          key: `bot_delay_before_discard_ends`,
        },
        {
          label: `Delay (in ms) during full bot play`,
          key: `bot_play_delay`,
        },
        // and debug hacking
        {
          label: `Set up a specific wall`,
          key: `wall_hack`,
          options: [``, ...Object.keys(WallHack.hacks)],
          debug_only: true,
        },
      ];

      options.forEach((entry) => {
        const { key } = entry;
        if (key) {
          const CONFIG_KEY = key.toUpperCase();
          entry.value = config[CONFIG_KEY];
          entry.default_value = config.DEFAULT_CONFIG[CONFIG_KEY];
        }
      });
      return options;
    }
  }

  class ScoreModal {
    constructor(modal) {
      this.modal = modal;
    }

    /**
     * Show the entire game's score progression
     */
    showFinalScores(gameui, rules, scoreHistory, resolve) {
      let panel = this.modal.makePanel(`final-scores`);
      panel.innerHTML = `<h3>Game finished</h3>`;

      let base = new Array(4).fill(rules.player_start_score);

      let table = document.createElement('table');
      let tbody = document.createElement('tbody');
      table.appendChild(tbody);
      tbody.innerHTML = `
      <tr>
        <th>hand</th>
        <th>player 0</th>
        <th>player 1</th>
        <th>player 2</th>
        <th>player 3</th>
        <th>&nbsp;</th>
      </tr>
      <tr>
        <td>&nbsp;</td>
        ${base.map(v => `<td>${v}</td>`).join('\n')}
        <td>&nbsp;</td>
      </tr>
    `;

      scoreHistory.forEach((record,hand) => {
        hand = hand + 1;
        let row = document.createElement('tr');
        let content = [0,1,2,3].map(id => {
          let winner = record.fullDisclosure[id].winner;
          let value = record.adjustments[id];
          let score = (base[id] = base[id] + value);
          let wind = record.fullDisclosure[id].wind;
          let title = [winner?'winner':false, wind===0?'east':false].filter(v=>v).join(', ');
          return `
          <td title="${title}">
            <span${wind===0 ? ` class="east"`:``} >${winner ? `<strong>${score}</strong>` : score}</span>
          </td>
        `;
        });
        row.innerHTML = `
        <td>${hand}</td>
        ${content.join('\n')}
        <td><button>details</button></td>
      `;
        row.querySelector('button').addEventListener('click', () => {
          // load a specific hand ending into the UI
          gameui.loadHandPostGame(record.fullDisclosure);
          // and show the score breakdown for that hand
          this.show(hand, rules, record.scores, record.adjustments);
        });
        tbody.appendChild(row);
      });
      panel.appendChild(table);

      this.modal.addFooter(panel, "Back to the menu", resolve);
      panel.scrollTop = 0;
    }

    /**
     * Show the end-of-hand score breakdown.
     */
    show(hand, rules, scores, adjustments, resolve) {
      let panel = this.modal.makePanel(`scores`);
      panel.innerHTML = `<h3>Scores for hand ${hand}</h3>`;

      let faanSystem = (rules.scoretype === Ruleset.FAAN_LAAK);
      let winner = 0;
      scores.some((e,id) => { winner = id; return e.winner; });

      let builder = document.createElement('div');
      builder.innerHTML = `
    <table>
      <tr>
        <th>&nbsp;</th>
        <th>player 0</th>
        <th>player 1</th>
        <th>player 2</th>
        <th>player 3</th>
      </tr>
      <tr>
        <td>winner</td>
        <td>${scores[0].winner ? '*' : ''}</td>
        <td>${scores[1].winner ? '*' : ''}</td>
        <td>${scores[2].winner ? '*' : ''}</td>
        <td>${scores[3].winner ? '*' : ''}</td>
      </tr>
      <tr>
        <td>${faanSystem ? `points` : `basic`}</td>
        <td>${scores[0].score}</td>
        <td>${scores[1].score}</td>
        <td>${scores[2].score}</td>
        <td>${scores[3].score}</td>
      </tr>
      ${faanSystem ? `` : `
      <tr>
        <td>doubles</td>
        <td>${scores[0].doubles}</td>
        <td>${scores[1].doubles}</td>
        <td>${scores[2].doubles}</td>
        <td>${scores[3].doubles}</td>
      </tr>
      `}
      <tr>
        <td>total</td>
        <td>${scores[0].total}</td>
        <td>${scores[1].total}</td>
        <td>${scores[2].total}</td>
        <td>${scores[3].total}</td>
      </tr>
      <tr>
        <td>win/loss</td>
        <td>${adjustments[0]}</td>
        <td>${adjustments[1]}</td>
        <td>${adjustments[2]}</td>
        <td>${adjustments[3]}</td>
      </tr>
      <tr class="details">
        <td>&nbsp;</td>
        <td>${ !faanSystem || (faanSystem && winner===0) ? `<button>details</button>` : ``}</td>
        <td>${ !faanSystem || (faanSystem && winner===1) ? `<button>details</button>` : ``}</td>
        <td>${ !faanSystem || (faanSystem && winner===2) ? `<button>details</button>` : ``}</td>
        <td>${ !faanSystem || (faanSystem && winner===3) ? `<button>details</button>` : ``}</td>
      </tr>
    </table>
    `;
      let table = builder.querySelector('table');
      Array
        .from(table.querySelectorAll('tr.details td'))
        .slice(1)
        .map((e,pid) => {
          e.addEventListener('click', evt => {
            this.showScoreDetails(pid, scores[pid].log, faanSystem);
          });
        });
      panel.appendChild(table);

      if (resolve) this.modal.addFooter(panel, "Play next hand", resolve, true);
      else this.modal.addFooter(panel, "OK");
    }

    /**
     * Show a detailed score log for a particular player.
     */
    showScoreDetails(pid, log, faanSystem) {
      let panel = this.modal.makePanel(`score-breakdown`);
      panel.innerHTML = `<h3>Score breakdown for player ${pid}</h3>`;

      let table = document.createElement('table');
      let data = [
        `<tr><th>points</th><th>element</th></tr>`,
        ...log.map(line => {
          let mark = ` for `;
          if (line.indexOf(mark) > -1) {
            let parts = line.split(mark);
            let pts = parts[0].replace(/doubles?/, `dbl`).replace(/faan/,'');
            return `<tr><td>${pts}</td><td>${parts[1]}</td></tr>`;
          } else {
            if (faanSystem)  return ``;
            return `<tr><td colspan="2">${line}</td></tr>`;
          }
        })
      ];
      table.innerHTML = data.join(`\n`);
      panel.appendChild(table);

      this.modal.addFooter(panel, "Back to the scores");
    }
  }

  function setStyleSheet(id, css) {
    let style = document.getElementById(id);
    if (style) {
      style.parentNode.removeChild(style);
    } else {
      style = document.createElement(`style`);
    }
    style.id = id;
    style.textContent = css;
    document.body.append(style);
  }

  class TileSetManager {
    static loadDefault() {
      this.createTileSetCSS(`./img/tiles/default-tileset.svg`).then((css) =>
        setStyleSheet(`default-tiles`, css)
      );
    }

    static createTileSetCSS(dataURL) {
      return new Promise((resolve) => {
        const img = new Image();
        img.src = dataURL;
        img.onload = (evt) => {
          const css = [];
          const tileWidth = img.width / 9;
          const tileHeight = img.height / 5;
          //console.log(img.width, img.height, tileWidth, tileHeight);
          const canvas = document.createElement(`canvas`);
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext(`2d`);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 9; c++) {
              const tileNumber = TileSetManager.getTileNumber(r, c);
              if (tileNumber === false) continue;

              const [x, y, w, h] = [
                tileWidth * c + 1,
                tileHeight * r + 1,
                tileWidth - 2,
                tileHeight - 2,
              ];

              const crop = document.createElement(`canvas`);
              crop.width = w;
              crop.height = h;
              crop.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
              css.push(
                `[tile="${tileNumber}"] { background-image: url(${crop.toDataURL()}); }`
              );
            }
          }
          resolve(css.join(`\n`));
        };
      });
    }

    static getTileNumber(row, col) {
      if (row < 3) return col + 9 * row;
      if (row === 3) {
        if (col < 4) return 27 + col;
        if (col === 4) return false;
        if (col < 8) return 31 - 5 + col;
      }
      if (row === 4) {
        if (col !== 8) return 34 + col;
        return -1;
      }
      return false;
    }
  }

  function fileLoader(evt) {
    return new Promise((resolve, reject) => {
      const file = evt.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          file.dataURL = e.target.result;
          if (file.size > 500000) {
            alert("Images over 500kb are not supported");
            return reject();
          }
          resolve(file);
        };
        reader.readAsDataURL(file);
      } else reject();
    });
  }

  class ThemeModal {
    constructor(modal) {
      this.modal = modal;
      this.init();
    }

    init() {
      this.loadBackground();
      this.loadSidebar();
      this.loadPlayerBanks();
      this.loadTileset();
    }

    reset() {
      [
        `mahjongBackground`,
        `mahjongSidebar`,
        `mahjongPlayerBanks`,
        `mahjongTileset`,
        `mahjongCSS`,
      ].forEach((key) => {
        localStorage.removeItem(key);
        const e = document.getElementById(`mahjongBackground`);
        if (e) {
          e.parentNode.removeChild(e);
        }
      });
      globalThis.location.reload();
    }

    loadBackground() {
      const dataURL = localStorage.getItem("mahjongBackground");
      if (dataURL) {
        setStyleSheet(
          `mahjongBackground`,
          `.board .discards { background-image: url(${dataURL}); }`
        );
      }
      return !!dataURL;
    }

    saveBackground(background) {
      localStorage.setItem("mahjongBackground", background);
    }

    loadSidebar() {
      const dataURL = localStorage.getItem("mahjongSidebar");
      if (dataURL) {
        setStyleSheet(
          `mahjongSidebar`,
          `.board .sidebar { background-image: url(${dataURL}); }`
        );
      }
      return !!dataURL;
    }

    saveSidebar(background) {
      localStorage.setItem("mahjongSidebar", background);
    }

    loadPlayerBanks() {
      const dataURL = localStorage.getItem("mahjongPlayerBanks");
      if (dataURL) {
        setStyleSheet(
          `mahjongPlayerBanks`,
          `.players .player { background-image: url(${dataURL}); }`
        );
      }
      return !!dataURL;
    }

    savePlayerBanks(background) {
      localStorage.setItem("mahjongPlayerBanks", background);
    }

    async loadTileset() {
      const dataURL = localStorage.getItem("mahjongTileset");
      if (dataURL) {
        setStyleSheet(
          `mahjongTileset`,
          await TileSetManager.createTileSetCSS(dataURL)
        );
      } else { TileSetManager.loadDefault(); }
      return !!dataURL;
    }

    saveTileset(background) {
      localStorage.setItem("mahjongTileset", background);
    }

    /**
     * Configure all the configurable options and
     * then relaunch the game on the appropriate URL.
     */
    show() {
      const panel = this.modal.makePanel(`settings`);
      panel.innerHTML = `<h3>Change the game theme</h3>`;
      const options = this.getOptions();
      const table = this.modal.buildPanelContent(options);
      this.addFormControls(panel, table, options);
      this.modal.addFooter(panel, "Close");
    }

    addFormControls(panel, table, options) {
      let row = document.createElement(`tr`);
      row.classList.add(`spacer-1`);
      row.innerHTML = `
      <td colspan="2">
        <input id="reset" type="reset" value="Reset to default settings">
      </td>
    `;
      table.appendChild(row);

      let reset = table.querySelector(`#reset`);
      reset.addEventListener("click", () => this.reset());
    }

    getOptions() {
      const handle = (fnName) => (entry, evt) =>
        fileLoader(evt).then((file) => {
          this[`save${fnName}`](file.dataURL);
          this[`load${fnName}`]();
        });

      const options = [
        {
          label: "Background image",
          type: `file`,
          handler: handle("Background"),
        },
        {
          label: "Sidebar image",
          type: `file`,
          handler: handle("Sidebar"),
        },
        {
          label: "Player banks",
          type: `file`,
          handler: handle("PlayerBanks"),
        },
        {
          label: "Tileset",
          type: `file`,
          handler: handle("Tileset"),
        },
        {
          label: "CSS colors",
          button_label: "Change...",
          type: `button`,
          evtType: `click`,
          handler: (entry, evt) => {
            this.modal.pickColors();
          }
        }
      ];

      return options;
    }
  }

  class ColorModal {
    constructor(modal) {
      this.modal = modal;
      this.overrides = {};
      this.loadColorScheme();
      // TODO: update `overrides` based on the localStorage data
    }

    reset() {
      const style = document.querySelector(`style#mahjongCSS`);
      if (style) style.parentNode.removeChild(style);
    }

    saveColor(entry) {
      if (entry.value !== entry.default_value) {
        this.overrides[entry.label] = entry;
      } else {
        this.overrides[entry.label] = undefined;
      }

      const colorCSS = `:root {${Object.entries(this.overrides)
      .filter(([label, entry]) => !!entry)
      .map(([label, entry]) => `${entry.key}: ${entry.value};`)
      .join(`\n`)}}`;

      localStorage.setItem(`mahjongCSS`, colorCSS);
      setStyleSheet(`mahjongCSS`, colorCSS);
    }

    loadColorScheme() {
      const colorCSS = localStorage.getItem("mahjongCSS");
      if (colorCSS) {
        setStyleSheet(`mahjongCSS`, colorCSS);
      }
      return !!colorCSS;
    }

    /**
     * Configure all the configurable options and
     * then relaunch the game on the appropriate URL.
     */
    show() {
      const panel = this.modal.makePanel(`settings`);
      panel.innerHTML = `<h3>Change CSS Colors</h3>`;
      const options = this.getOptions(panel);
      const table = this.modal.buildPanelContent(options);
      this.addFormControls(table);
      this.modal.addFooter(panel, "Close");
    }

    addFormControls(table) {
      let row = document.createElement(`tr`);
      row.classList.add(`spacer-1`);
      row.innerHTML = `
        <td colspan="2">
          <input id="reset" type="reset" value="Reset to default settings">
        </td>
      `;
      table.appendChild(row);

      let reset = table.querySelector(`#reset`);
      reset.addEventListener("click", () => this.reset());
    }

    getCSSColors() {
      const s = Array.from(document.styleSheets).find((s) =>
        s.ownerNode.href.includes(`/colors.css`)
      );
      const colors = Array.from(s.rules[0].style);
      const colorsForHumans = colors.map((v) =>
        v.replace(/^--/, "").replaceAll("-", " ")
      );
      const values = colors.map((v) =>
        getComputedStyle(document.documentElement).getPropertyValue(v)
      );
      return { colors, colorsForHumans, values };
    }

    getOptions() {
      const colors = this.getCSSColors();
      const get = (l) => this.overrides[l]?.value;
      const hex = (c) => this.getHexColor(c);
      const save = (entry) => this.saveColor(entry);

      const options = colors.colorsForHumans.map((label, i) => {
        return {
          label: label,
          key: colors.colors[i],
          value: get(label) || hex(colors.values[i]),
          default_value: hex(colors.values[i]),
          type: `color`,
          evtType: `input`,
          get handler() {
            return (entry, evt, opacity) => {
              if (evt) this.value = hex(evt.target.value);
              if (opacity) {
                this.value =
                  this.value.substring(0, 7) +
                  parseInt(opacity).toString(16).padStart(2, "0");
              }
              save(this);
            };
          },
        };
      });

      return options;
    }

    getHexColor(cssColor) {
      const canvas = document.createElement(`canvas`);
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      ctx.beginPath();
      ctx.rect(-1, -1, 2, 2);
      ctx.fillStyle = cssColor;
      ctx.fill();
      const [r, g, b, a] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      if (a < 255) {
        const v = ((r << 24) + (g << 16) + (b << 8) + a).toString(16);
        return `#${v.padStart(8, "0")}`;
      }
      const v = ((r << 16) + (g << 8) + b).toString(16);
      return `#${v.padStart(6, "0")}`;
    }
  }

  /**
   * A modal dialog handling class. The actual dialog
   * content is written up in other files, this file
   * merely houses the code that sets up the modal
   * functionality such as show/hide and dialog stacking.
   */
  class Modal {
    constructor(fixed = false) {
      this.fixed = fixed;
      this.modal = document.querySelector(".modal");
      this.gameBoard = document.querySelector(".board");
      this.panels = [];
      this.choice = new OptionsDialog(this);
      this.settings = new SettingsModal(this);
      this.theming = new ThemeModal(this);
      this.colors = new ColorModal(this);
      this.scores = new ScoreModal(this);
    }

    // show the modal stack
    reveal() {
      this.modal.classList.remove("hidden");
    }

    // is the modal stack visible?
    isHidden() {
      return this.modal.classList.contains("hidden");
    }

    // hide the modal stack
    hide() {
      this.modal.classList.add("hidden");
    }

    /**
     * Create a new modal panel to show data in.
     */
    makePanel(name) {
      let panels = this.panels;
      let panel = document.createElement("div");
      panel.classList.add("panel");
      if (name) panel.classList.add(name);
      panels.forEach((p) => (p.style.display = "none"));
      panels.push(panel);
      this.modal.appendChild(panel);
      return panel;
    }

    /**
     * Close the currently-active modal, which will either
     * reveal the underlying modal, or hide the master overlay.
     */
    close(unbind = []) {
      unbind.forEach((opt) => {
        opt.object.addEventListener(opt.evtName, opt.handler);
      });
      let modal = this.modal;
      let panels = this.panels;
      let panel = panels.pop();
      if (panel) modal.removeChild(panel);
      if (panels.length) {
        let panel = panels[panels.length - 1];
        panel.style.display = "block";
        if (panel.gainFocus) panel.gainFocus();
      } else {
        this.hide();
        this.gameBoard.focus();
      }
    }

    /**
     * TODO: merge options, values, and differs, because
     * there is no reason at all for those to not be unified.
     */
    buildPanelContent(options, wrapInForm = false) {
      const debug = config.DEBUG;

      const form = wrapInForm ? document.createElement(`form`) : undefined;
      const table = document.createElement(`table`);
      this.panels.last().append(table);

      options.forEach((entry) => {
        const { label, button_label, key, value, default_value } = entry;
        const { toggle, type, evtType, handler, debug_only, disabled } = entry;
        let options = entry.options;
        let row;

        if (!label) {
          row = document.createElement(`tr`);
          row.innerHTML = `<td colspan="2">&nbsp;</td>`;
          return table.appendChild(row);
        }

        if (debug_only && !debug) {
          return;
        }

        row = document.createElement(`tr`);
        let field = `<input class="${key} field" type"${
        type || `text`
      }" value="${value}">`;

        if (options || toggle) {
          options = toggle ? [true, false] : options;

          field = `
          <select class="${key} field"${disabled? " disabled" : ""}>
            ${options.map(
              (opt) =>
                `<option value="${opt}"${
                  opt === value ? ` selected` : ``
                }>${`${opt}`.replace(/_/g, " ")}</option>`
            )}
          </select>`;
        }

        if (type === `file`) {
          field = `<input class="${key} picker field" type="${type}" value="pick...">`;
        }

        if (type === `button`) {
          field = `<input class="${key} picker field" type="${type}" value="${button_label}">`;
        }

        if (type === `color`) {
          field = `<input class="${key} picker field" type="${type}" value="${value.substring(
          0,
          7
        )}">`;
          if (value.length === 9) {
            // HTML5 can't do opacity natively using <input type="color">...
            field += `<input class="${key} opacity" type="range" min="0" max="255" step="1" value="${parseInt(
            value.substring(7),
            16
          )}">`;
          }
        }

        row.innerHTML = `
        <td style="white-space: nowrap;" data-toggle="${key}" ${
        toggle && !value ? `class="greyed"` : ``
      }>${label}</td>
        <td ${value != default_value ? ` class="custom"` : ``}>${field}</td>
      `;
        table.appendChild(row);

        const input = row.querySelector(`.field`);
        input.addEventListener(evtType || `input`, (evt) => {
          if (handler) {
            handler(entry, evt);
          } else {
            entry.value = evt.target.value;
          }
        });

        input.addEventListener(`input`, () => {
          //console.log(input.value, default_value);
          if (input.value !== default_value.toString()) {
            input.parentNode.classList.add(`custom`);
          } else {
            input.parentNode.classList.remove(`custom`);
          }
        });


        if (toggle) {
          const inputLabel = row.querySelector(`[data-toggle="${key}"]`);
          input.addEventListener(`input`, () => inputLabel.classList.toggle(`greyed`));
        }

        // make sure we get opacity changes set over as well.
        if (type === `color`) {
          const opacity = row.querySelector(`.field + .opacity`);
          if (opacity) {
            opacity.addEventListener(`input`, (evt) => {
              handler(entry, false, evt.target.value);
            });
          }
        }
      });

      if (wrapInForm) {
        form.append(table);
        this.panels.last().append(form);
        return form;
      }

      this.panels.last().append(table);
      return table;
    }

    /**
     * Add a generic footer with an "OK" button,
     * and automated focus handling.
     */
    addFooter(panel, modalLabel = "OK", resolve = () => {}, botDismissible) {
      let ok = document.createElement("button");
      ok.id = "okButton";
      ok.textContent = modalLabel;
      ok.addEventListener("click", () => {
        this.close([
          { object: document, evntName: "focus", handler: panel.gainFocus },
        ]);
        resolve();
      });
      panel.appendChild(ok);

      // Auto-dismiss the score panel during bot play,
      // UNLESS the user interacts with the modal.
      if (config.BOT_PLAY && botDismissible) {
        let dismiss = () => ok.click();
        setTimeout(() => dismiss(), config.HAND_INTERVAL);
        panel.addEventListener("click", () => (dismiss = () => {}));
      }

      panel.gainFocus = () => ok.focus();
      document.addEventListener("focus", panel.gainFocus);

      let defaultFocus = (evt) => {
        let name = evt.target.nodeName.toLowerCase();
        if (name === "select" || name === "input") return;
        panel.gainFocus();
      };

      panel.addEventListener("click", defaultFocus);
      panel.addEventListener("touchstart", defaultFocus, { passive: true });
      panel.gainFocus();
    }

    /**
     * Offer a button dialog modal
     */
    choiceInput(label, options, resolve, cancel) {
      this.reveal();
      this.choice.show(label, options, resolve, cancel);
    }

    /**
     * Show the end-of-hand score breakdown.
     */
    setScores(hand, rules, scores, adjustments, resolve) {
      this.reveal();
      this.scores.show(hand, rules, scores, adjustments, resolve);
    }

    /**
     * Show the end-of-game score breakdown.
     */
    showFinalScores(gameui, rules, scoreHistory, resolve) {
      this.reveal();
      this.scores.showFinalScores(gameui, rules, scoreHistory, resolve);
    }

    /**
     * Show all available settings for the game.
     */
    pickPlaySettings() {
      this.reveal();
      this.settings = new SettingsModal(this);
      this.settings.show();
    }

    /**
     * Show theming options for the game
     */
    pickTheming() {
      this.reveal();
      this.theming.show();
    }

    /**
     * Show theming options for the game
     */
    pickColors() {
      this.reveal();
      this.colors.show();
    }
  }

  let modal = new Modal();

  /**
   * This is an administrative class that is used by Players
   * to track how many instances of each tile are, potentially,
   * still left in the game, based on incomplete information
   * received during the playing of a hand.
   */
  class TileTracker {
    constructor(id) {
      this.id = id;
      this.tiles = [];
      this.ui = false;
      this.reset();
    }

    setUI(ui) {
      this.ui = ui;
    }

    /**
     * Reset all tiles to "there are four".
     */
    reset() {
      let tiles = (new Array(34)).fill(4);
      tiles.push(1,1,1,1,1,1,1,1);
      this.tiles = Object.assign({}, tiles);
      if (this.ui) this.ui.resetTracker(this.tiles);
    }

    /**
     * Fetch the count associated with a specific tile.
     */
    get(tileNumber) {
      return this.tiles[tileNumber];
    }

    /**
     * Mark a specific tile as having been revealed to this
     * player (but not necessarily to all players!)
     */
    seen(tileNumber) {
      if (tileNumber.dataset) {
        console.log(`Player ${this.id} tracker was passed an HTMLElement instead of a tile`);
        console.trace();
        throw new Error('why is the tracker being given an HTML element?');
      }
      this.tiles[tileNumber]--;
      if (this.ui) this.ui.reduceTracker(tileNumber);
    }
  }

  // =========================================
  //        Let's define a Player class!
  // =========================================

  class PlayerMaster {
    constructor(id) {
      this.el = document.createElement('div');
      this.el.setAttribute('class', 'player');
      this.el.id = id;
      this.id = id;
      this.tracker = new TileTracker(this.id);
      this.ui = false;
      this.wincount = 0;
      this.reset();
    }

    reset(wind, windOfTheRound, hand, draws) {
      this.wind = wind;
      this.windOfTheRound = windOfTheRound;
      this.draws = draws;
      this.discards = []; // tracks this player's discards over the course of a hand
      this.tiles = [];
      this.locked = [];
      this.bonus = [];
      this.waiting = false; // waiting to win?
      this.has_won = false; // totally has won!
      this.selfdraw = false;
      this.robbed = false; // won by robbing a kong?
      this.tracker.reset();
      this.el.innerHTML = '';
      this.el.classList.add('winner');
      if (this.ui) this.ui.reset(wind, windOfTheRound, hand, draws);
    }

    /**
     * Pause play as far as this player is concerned.
     */
    pause(lock) {
      this.paused = lock;
      if (this.ui) this.ui.pause(lock);
    }

    /**
     * Resume play as far as this player is concerned.
     */
    resume() {
      if (this.ui) this.ui.resume();
      this.paused = false;
    }

    /**
     * Signal that the game will start
     */
    gameWillStart(game, rules) {
      if (this.ui) this.ui.gameWillStart();
      this.setActiveGame(game);
      this.setRules(rules);
    }

    /**
     * Set the game this player is now playing in.
     */
    setActiveGame(game) {
      this.game = game;
    }

    /**
     * Bind the ruleset that this player should "follow"
     * during the game they are currently in.
     */
    setRules(rules) {
      this.rules = rules;
      this._score = this.rules.player_start_score;
      if (this.ui) this.ui.setRules(rules);
    }

    /**
     * Signal that a specific hand will start
     */
    handWillStart(redraw, resolve) {
      if (this.ui) this.ui.handWillStart(redraw, resolve);
      else resolve();
    }

    /**
     * Signal that actual play is about to start
     * during a hand. This is called after all the
     * initial tiles have been dealt, and all players
     * have declared any kongs they might have had
     * in their hand as a consequence.
     */
    playWillStart() {
      if (this.ui) this.ui.playWillStart();
    }

    /**
     * Take note of how many tiles there are left
     * for playing with during this hand.
     */
    markTilesLeft(left, dead) {
      this.tilesLeft = left;
      this.tilesDead = dead;
      if (this.ui) this.ui.markTilesLeft(left, dead);
    }

    /**
     * Disclose this player's hand information.
     */
    getDisclosure() {
      return {
        // tile information
        concealed: this.getTileFaces().filter(v => v < 34),
        locked: this.locked,
        bonus: this.bonus,
        // play information,
        discards: this.discards.map(t => t?t.getTileFace():t),
        // player information
        wind: this.wind,
        winner: this.has_won,
        wincount: this.getWinCount(),
        // If this player has won, did they self-draw their winning tile?
        selfdraw: this.has_won ? this.selfdraw : false,
        selftile: (this.has_won && this.selfdraw) ? this.latest : false,
        robbed: this.robbed,
        // If this player has won, the last-claimed tile can matter.
        final: this.has_won ? this.latest.getTileFace() : false
      };
    }

    /**
     * Signal that the hand has ended. If the hand
     * was a draw, there will no arguments passed.
     * If the hand was won, the `fullDisclosures`
     * object contains all player's disclosures.
     */
    endOfHand(fullDisclosure) {
      if (this.ui) this.ui.endOfHand(fullDisclosure);
    }

    /**
     * Signal that the game has ended, with the final
     * game scores provided in the `scores` object.
     */
    endOfGame(scores) {
      if (this.ui) this.ui.endOfGame(scores);
    }

    /**
     * Work a score adjustment into this player's
     * current score.
     */
    recordScores(adjustments) {
      this._score += adjustments[this.id];
      if (this.ui) this.ui.recordScores(adjustments);
    }

    /**
     * Get this player's current game score.
     */
    getScore() {
      return this._score;
    }

    /**
     * Signal that this is now the active player.
     */
    activate(id) {
      if (this.ui) this.ui.activate(id);
    }

    /**
     * Signal that this is not an active player.
     */
    disable() {
      if (this.ui) this.ui.disable();
    }

    /**
     * Internal function for marking self as waiting
     * to win, using any tile noted in `winTiles`.
     */
    markWaiting(winTiles={}) {
      this.waiting = winTiles;
      if (this.ui) this.ui.markWaiting(winTiles);
    }

    /**
     * Mark this player as winner of the current hand.
     */
    markWinner() {
      if (!this.has_won) {
        this.has_won = true;
        this.wincount++;
        if (this.ui) this.ui.markWinner(this.wincount);
      }
    }

    /**
     * How many times has this player won?
     */
    getWinCount() {
      return this.wincount;
    }

    /**
     * Add a tile to this player's hand.
     */
    append(tile, claimed, supplement) {
      let face;
      let revealed = false;

      if (typeof tile !== 'object') {
        face = tile;
        tile = create(tile);
      } else {
        face = tile.getTileFace();
      }

      this.latest = tile;

      if (tile.isBonus()) {
        revealed = face;
        this.bonus.push(face);
      } else {
        this.tiles.push(tile);
      }

      if (!claimed) {
        this.tracker.seen(tile.getTileFace());
        this.lastClaim = false;
      }

      if (supplement) tile.supplement();
      if (this.ui) this.ui.append(tile);
      return revealed;
    }

    /**
     * Remove a tile from this player's hand
     * (due to a discard, or locking tiles, etc).
     */
    remove(tile) {
      let pos = this.tiles.indexOf(tile);
      this.tiles.splice(pos, 1);
      if (this.ui) this.ui.remove(tile);
    }

    /**
     * Can we chow off of the indicated player?
     */
    mayChow(pid) {
      return ((pid+1)%4 == this.id);
    }

    /**
     * Player formed a kong by having a pung on
     * the table, and drawing the fourth tile
     * themselves.
     */
    meldKong(tile) {
      this.remove(tile);
      let set = this.locked.find(set => (set[0].getTileFace() === tile.getTileFace()));
      let meld = set[0].cloneNode(true);
      meld.meld();
      set.push(meld);
      if (this.ui) this.ui.meldKong(tile);
    }

    /**
     * Check whether this player has, and if so,
     * wants to declare, a kong. Implement by bot.
     */
    async checkKong() {
      return false;
    }

    /**
     * Take note of the fact that a player revealed
     * one or more tiles, either due to discarding,
     * revealing a bonus tile, or by claiming/melding
     * a set.
     */
    see(tiles, player) {
      if (player === this) return;
      if (!tiles.map) tiles = [tiles];
      tiles.forEach(tile => this.tracker.seen(tile));
      if (this.ui) this.ui.see(tiles, player);
    }

    /**
     * Take note of the fact that a different player
     * received a tile for whatever reason.
     */
    receivedTile(player) {
      if (this.ui) this.ui.receivedTile(player);
    }

    /**
     * Get the play information in terms of what this player
     * might be looking for, whether they're ready to win,
     * etc. based on Pattern expansion.
     */
    tilesNeeded() {
      return tilesNeeded(this.getTileFaces(), this.locked);
    }

    /**
     * Take note of the fact that a different player
     * discarded a specific tile.
     */
    playerDiscarded(player, discard, playcounter) {
      let tile = discard.getTileFace();
      if (this.id != player.id) this.tracker.seen(tile);
      if (this.ui) this.ui.playerDiscarded(player, tile, playcounter);
    }

    /**
     * Take note of the fact that a different player
     * declared a kong.
     */
    async seeKong(tiles, player, tilesRemaining, resolve) {
      this.see(tiles.map(t => t.getTileFace()), player);
      this.robKong(player.id, tiles, tilesRemaining, resolve);
    }

    /**
     * Implemented by subclasses: this function tries
     * to rob a kong. If it can't, call `resolve()`,
     * but if it can, form a `claim` and then call
     * `resolve(claim)` with the appropriate wintype
     * set, as well as `from`, `tile`, and `by`:
     *
     * `from`: the player id of the person we're robbing.
     * `tile`: the tile number we're robbing.
     * `by`: our player id.
     *
     */
    async robKong(pid, tiles, tilesRemaining, resolve) {
      resolve();
    }

    /**
     * Give up a kong tile, if someone robbed it to win.
     */
    giveUpKongTile(tile) {
      let set = this.locked.find(set => set.length===4 && set[0].getTileFace() === tile);
      let discard = set.splice(0,1)[0];
      discard.unconceal();
      return discard;
    }

    /**
     * Take note of a player having to give up a kong
     * because someone just robbed it to win.
     */
    playerGaveUpKongTile(pid, tilenumber) {
      if (this.ui) this.ui.playerGaveUpKongTile(pid, tilenumber);
    }

    /**
     * Take note of the fact that a different player
     * claimed a discard to form a set.
     */
    seeClaim(tiles, player, claimedTile, claim) {
      if (player === this) return;
      if (!tiles.map) tiles = [tiles];

      tiles.forEach((tile, pos) => {
        // We've already seen the discard that got claimed
        if (tile === claimedTile) return;
        // But we haven't seen the other tiles yet.
        this.tracker.seen(tile.getTileFace());
      });
      if (this.ui) this.ui.seeClaim(tiles, player, claim);
    }

    /**
     * Signal that the current player is done.
     */
    nextPlayer() {
      if (this.ui) this.ui.nextPlayer();
    }

    getAvailableTiles() {
      return this.tiles;
    }

    getSingleTileFromHand(tile) {
      return this.tiles.find(t => (t.getTileFace() == tile));
    }

    getAllTilesInHand(tile) {
      return this.tiles.filter(t => (t.getTileFace() == tile));
    }

    getTiles(allTiles) {
      return allTiles ? [...this.tiles, ...this.bonus] : this.tiles;
    }

    getTileFaces(allTiles) {
      return this.getTiles(allTiles).map(t => (t.getTileFace ? t.getTileFace() : t)).sort((a,b)=>(a-b));
    }

    getLockedTileFaces() {
      return this.locked.map(set => `[${set.map(v=>v.getTileFace()).sort((a,b)=>(a-b))}]${set.winning?'!':''}`);
    }

    sortTiles() {
      if (this.ui) this.ui.sortTiles();
    }

    /**
     * Check whether a chow can be formed using `tile` from
     * player with id `pid`, by looking at our hand tiles.
     */
    async chowExists(pid, tile)  {
      // If this isn't a numerical tile, no chow can be formed.
      if (tile > 26)  return CLAIM.IGNORE;

      // nor if the discard did not come from the previous player.
      let next = (pid + 1) % 4;
      let valid = next == this.id;
      if (!valid) return CLAIM.IGNORE;

      // We're still here: can we form a chow with this discard?
      let tiles = this.getTileFaces();
      let face = tile % 9;
      let tm2 = (face > 1) ? tiles.indexOf(tile - 2) >= 0 : false;
      let tm1 = (face > 0) ? tiles.indexOf(tile - 1) >= 0 : false;
      let t1  = (face < 8) ? tiles.indexOf(tile + 1) >= 0 : false;
      let t2  = (face < 7) ? tiles.indexOf(tile + 2) >= 0 : false;
      let c1 = t1 && t2;
      let c2 = tm1 && t1;
      let c3 = tm2 && tm1;

      if (c1) return CLAIM.CHOW1;
      if (c3) return CLAIM.CHOW3;
      if (c2) return CLAIM.CHOW2;
      return CLAIM.IGNORE;
    }
  }

  /**
   * A resolver class that will run the function
   * passed as `startWaiting`, with a concurrent
   * timeout running that will trigger the
   * `timeoutFunction` function after a specific
   * number of milliseconds.
   *
   * This timeout can be paused using `.pause()`,
   * which will return a promise that can be
   * `await`ed to effect a non-blocking "pause".
   */
  class TaskTimer {
    static id = 0;
    static timers = {};

    /**
     * Create a timed task monitor.
     *
     * @param {function} startWaiting the function that gets called when the task timer starts, with the timer itself as function argument.
     * @param {function} timeoutFunction the function that will get called if the allocated task time runs out.
     * @param {milliseconds} timeoutInterval the timeout interval in milliseconds.
     * @param {function} signalHandler (optional) function that can be called at regular intervals over the course of the timeout.
     * @param {int} signalCount (optional) the number of signals to send over the course of the timeout, INCLUDING signal "0" at the start.
     */
    constructor(startWaiting, timeoutFunction, timeoutInterval, signalHandler=false, signalCount=0) {
      this.id = TaskTimer.id++;
      this.paused = false;
      this.created = Date.now();
      this.overrideKickedIn = false;
      this.timeoutInterval = timeoutInterval;

      this.timeoutFunction = () => {
        TaskTimer.__forget__(this);
        timeoutFunction();
      };

      if (signalHandler && signalCount > 0) {
        this.signalHandler = signalHandler;
        this.totalSignalCount = signalCount + 1;
        if (this.totalSignalCount < 1) this.totalSignalCount = 1;
        this.signalCount = this.totalSignalCount;
        this.sendSignal();
      }

      setTimeout(() => startWaiting(this), 0);
      this.startTimeout();
      TaskTimer.__record__(this);
    }

    /**
     * Class function: record this timer in the list of active timers.
     */
    static __record__(timer) {
      TaskTimer.timers[timer.id] = timer;
    }

    /**
     * Class function: remove this timer from the list of active timers.
     */
    static __forget__(timer) {
      delete TaskTimer.timers[timer.id];
    }

    /**
     * activate the override function
     */
    startTimeout() {
      this.overrideTrigger = setTimeout(() => {
        this.overrideKickedIn = true;
        this.timeoutFunction();
      }, this.timeoutInterval);
    }

    /**
     * send a regular(ish) signal while the timeout is active.
     */
    sendSignal() {
      let handler = this.signalHandler;
      if(!handler) return;

      // send a signal
      let signalNumber = this.totalSignalCount - (this.signalCount--);
      // console.debug('sendSignal in TaskTimer', this.totalSignalCount, this.signalCount);
      handler(signalNumber);

      // calculate how long the wait interval should now be
      // based on how much time is left until the timeout.
      if (!this.isPaused() && this.signalCount>0) {
        let elapsed = Date.now() - this.created;
        let remaining = this.timeoutInterval - elapsed;
        let timeoutValue = remaining / this.signalCount;
        // console.debug('nextSignal in TaskTimer =', timeoutValue, 'from', this.signalCount,"over", remaining);
        this.nextSignal = setTimeout(() => this.sendSignal(), timeoutValue);
      }
    }

    /**
     * has this timer timed out?
     */
    hasTimedOut() {
      return this.overrideKickedIn;
    }

    /**
     * cancel the timeout part of this timer, and
     * remove it from the list of active timers,
     * as the "timer" part no longer applies.
     *
     * If `__preserveTimer` is true, this timer
     * is not removed from the list of known
     * timers, which is important, because the
     * `pause()` function relies on  `cancel()`!
     */
    cancel(__preserveTimer) {
      if (this.nextSignal) clearTimeout(this.nextSignal);

      if (!this.overrideKickedIn) {
        clearTimeout(this.overrideTrigger);
        if (!__preserveTimer) {
          if (this.signalHandler) this.signalHandler(this.totalSignalCount-1);
          TaskTimer.__forget__(this);
        }
      }
    }

    /**
     * Is this timer currently paused? If so,
     * return the promise for await'ing purposes.
     */
    isPaused() {
      return this.paused;
    }

    /**
     * Temporarily suspend this timer's timeout.
     */
    pause() {
      this.cancel(true);
      let elapsed = Date.now() - this.created;
      this.timeoutInterval =  this.timeoutInterval - elapsed;

      // set up the main task pause
      let resolver = resolve => (this._resolve_pause_lock = resolve);
      this.paused = new Promise(resolver);

      return this.paused;
    }

    /**
     * Resume this timer's timeout.
     */
    resume() {
      if (this._resolve_pause_lock) {
        this.paused = false;
        this.created = Date.now();
        this._resolve_pause_lock();
        this.startTimeout();
        this.sendSignal();
      }
    }

    /**
     * Class function: pause all known timers.
     */
    static pause() {
      for (timer of TaskTimer.timers) timer.pause();
      if (!TaskTimer.paused) {
        let resolver = resolve => (TaskTimer._resolve_pause_lock = resolve);
        TaskTimer.paused = new Promise(resolver);
      }
      return TaskTimer.paused;
    }

    /**
     * Class function: resume all known timers.
     */
    static resume() {
      TaskTimer._resolve_pause_lock();
      TaskTimer.paused = false;
      for (timer of TaskTimer.timers) timer.resume();
    }
  }

  // static properties
  TaskTimer.id = 0;
  TaskTimer.timers = {};

  // =========================================
  //        Let's define a Player class!
  // =========================================

  class Player extends PlayerMaster {
    constructor(id) {
      super(id);
    }

    async getDiscard(tilesRemaining, resolve) {
      let resolveProxy = (discard) => {
        this.discards.push(discard);
        resolve(discard);
      };
      return this.determineDiscard(tilesRemaining, resolveProxy);
    }

    /**
     * players have a way to determine what the discard,
     * but we're not going to specify _how_ to determine
     * that here. We'll leave that up to the specific
     * player types instead.
     */
    determineDiscard(tilesRemaining, resolve) {
      resolve(undefined);
    }

    /**
     * In terms of universal behaviour, we want
     * to make sure that we exit early if this is
     * "our own" discard. No bidding on that please.
     */
    async getClaim(pid, discard, tilesRemaining, resolve) {
      if (pid == this.id) return resolve({ claimtype: CLAIM$1.IGNORE });

      new TaskTimer(
        timer => {
          let claimfn = claim => timer.hasTimedOut() ? false : resolve(claim);
          let cancelfn = () => timer.cancel();
          this.determineClaim(pid, discard, tilesRemaining, claimfn, cancelfn, timer);
        },
        () => resolve({ claimtype: CLAIM$1.IGNORE }),
        config.CLAIM_INTERVAL
      );
    }

    /**
     * Just like determineDiscard, players have a way
     * to determine whether they want a discard, and
     * for what, but we're not going to say how to
     * determine that in this class.
     */
    determineClaim(pid, discard, tilesRemaining, resolve, interrupt, claimTimer) {
      resolve({ claimtype: CLAIM$1.IGNORE });
    }

    /**
     * Handle receiving a tile in order to fulfill a
     * claim that was put out on a discard by this
     * player during a play turn.
     */
    receiveDiscardForClaim(claim, discard) {
      this.lastClaim = claim;
      let tile = discard.getTileFace();
      let claimtype = claim.claimtype;

      let set = [];
      set.push(discard);
      set.locked = true;

      if (claimtype === CLAIM$1.WIN) {
        this.markWinner();
        if (!set.winning) claimtype = claim.wintype; // prevent double counting!
        set.winning = true;
        if (claimtype === CLAIM$1.CHOW) {
          claimtype = convertSubtypeToClaim(claimtype);
        }
      }

      this.append(discard, true);

      discard.lock();
      if(this.has_won) discard.winning();

      // lock related tiles if this was a pung/kong
      if (claimtype === CLAIM$1.PAIR || claimtype === CLAIM$1.PUNG || claimtype === CLAIM$1.KONG) {
        let count = 0;
        if (claimtype === CLAIM$1.PAIR) count = 1;
        if (claimtype === CLAIM$1.PUNG) count = 2;
        if (claimtype === CLAIM$1.KONG) count = 3;

        let tiles = this.getAllTilesInHand(tile);
        tiles = Array.from(tiles).slice(0,count);

        Array.from(tiles).forEach(t => {
          if (t.getTileFace() == tile) {
            t.reveal();
            t.lock();
            if(this.has_won) t.winning();
            set.push(t);
          }
        });

        this.lockClaim(set);
        return set;
      }

      // No pair, pung, or kong: must be a chow... but which type of chow?
      let t1, t2;
      if (claimtype === CLAIM$1.CHOW1) {
        t1 = this.getSingleTileFromHand(tile + 2);
        t2 = this.getSingleTileFromHand(tile + 1);
      }
      else if (claimtype === CLAIM$1.CHOW2) {
        t1 = this.getSingleTileFromHand(tile + 1);
        t2 = this.getSingleTileFromHand(tile - 1);
      }
      else if (claimtype === CLAIM$1.CHOW3) {
        t1 = this.getSingleTileFromHand(tile - 1);
        t2 = this.getSingleTileFromHand(tile - 2);
      }

      [t1, t2].forEach(t => {
        t.reveal();
        t.lock();
        if(this.has_won) t.winning();
        set.push(t);
      });

      this.lockClaim(set);
      return set;
    }

    /**
     * Lock away a set of tiles, for all
     * to see and know about.
     */
    lockClaim(tiles, concealed=false) {
      let kong = (tiles.length === 4);

      tiles.forEach(tile => {
        this.remove(tile);
        tile.unmark('latest');
        tile.setTitle(``);
        tile.lock();
        if(kong) tile.conceal();
      });

      // a claimed kong implies this player
      // had a concealed pung in their hand.
      if (kong && !concealed) {
        delete tiles[0].conceal();
      }

      this.locked.push(tiles);
      if (this.ui) this.ui.lockClaim(tiles);
    }
  }

  /**
   * Build an object that represents "what we have"
   * so we can reason about what we might be able
   * to play for. E.g. if we have 3 chows, going for
   * a pung hand is probably not a good idea, and
   * if we have 10 tiles in one suit, and 1 tile
   * in the other two suits, we probably want to
   * try to get one suit hand.
   */
  function buildStatsContainer(player) {
    let tiles = player.tiles.map(t => t.getTileFace()).sort();
    let locked = player.locked.map(s => s.map(t => t.getTileFace()).sort());
    let tileCount = (new Array(42)).fill(0);

    let suit = t => (t/9)|0;

    let stats = {
      cpairs: 0,   // connected pairs: {t,t+1} or {t,t+2}
      pairs: 0,
      chows: 0,
      pungs: 0,
      bigpungs: 0, // dragons, own wind, wotr
      tiles: 0,    // how many tiles total
      counts: {},  // tile->howmany tracking object
      numerals: 0,
      terminals: 0,
      honours: 0,
      winds: 0,
      dragons: 0,
      suits: [0, 0, 0],
      // Separate container specific to locked sets:
      locked: { chows: 0, pungs: 0, bigpungs: 0, tiles: 0, numerals: 0, suits: [0, 0, 0] }
    };

    // Analyse the locked sets and gather stats.
    locked.forEach(set => {
      let tileNumber = set[0];
      if (tileNumber === set[1]) {
        stats.pungs++;
        stats.locked.pungs++;
        if (tileNumber < 27) {
          stats.numerals += set.length;
          stats.locked.numerals += set.length;
          stats.suits[suit(tileNumber)]++;
          stats.locked.suits[suit(tileNumber)]++;
        }
        if (tileNumber + 27 === player.wind) {
          stats.bigpungs++;
          stats.locked.bigpungs++;
        }
        if (tileNumber + 27 === player.windOfTheRound) {
          stats.bigpungs++;
          stats.locked.bigpungs++;
        }
        if (tileNumber > 30) {
          stats.bigpungs++;
          stats.locked.bigpungs++;
        }
      } else {
        stats.chows++;
        stats.locked.chows++;
        stats.numerals += set.length;
        stats.locked.numerals += set.length;
        stats.suits[suit(tileNumber)]++;
        stats.locked.suits[suit(tileNumber)]++;
      }
      stats.tiles += set.length;
      stats.locked.tiles += set.length;
    });

    // Analyse our hand tiles and gather stats
    tiles.forEach(tileNumber => {
      if (tileNumber <= 26) {
        stats.numerals++;
        let face = (tileNumber%9);
        if (face===0 || face===8) stats.terminals++;
        stats.suits[suit(tileNumber)]++;
      } else {
        stats.honours++;
        if (26 < tileNumber && tileNumber <= 30) stats.winds++;
        if (30 < tileNumber && tileNumber <= 33) stats.dragons++;
      }
      tileCount[tileNumber]++;
      stats.tiles++;
      if (!stats.counts[tileNumber]) stats.counts[tileNumber] = 0;
      stats.counts[tileNumber]++;
    });

    // Finally, there are some checks that are easier to do
    // once we have the tile->howany stats available.
    tileCount.forEach((count,tileNumber) => {
      // because we care about chow potential, we have
      // to basically run a three-tile sliding window.
      if (count && tileNumber <= 24) {
        let c2, c3;
        let tsuit = suit(tileNumber);
        let t2 = tileNumber + 1;
        if (suit(t2)===tsuit) {
          c2 = tileCount[t2];
          let t3 = tileNumber + 2;
          if (suit(t3)===tsuit) {
            c3 = tileCount[t3];
          }
        }
        if (c2 && c3) stats.chows++;
        else if (c2 || c3) stats.cpairs++;
      }
      if (count===2) stats.pairs++;
      if (count>=3) {
        stats.pungs++;
        if (tileNumber + 27 === player.wind) { stats.bigpungs++; }
        if (tileNumber + 27 === player.windOfTheRound) { stats.bigpungs++; }
        if (tileNumber > 30) { stats.bigpungs++; }
      }
    });

    return stats;
  }

  /**
   * This is a class that regulates, given a tile that a bot might
   * have the opportunity to claim, whether or not to claim it.
   */
  class Personality {
    constructor(player) {
      this.player = player;

      // This determines whether or not we consider
      // scoring an otherwise chicken hand, as long
      // as it has something that scores points, like
      // a pung of dragons, or own/wotr winds.
      this.allowScoringChicken = true;

      // How many of our tiles need to be of one suit
      // before we decide to go for a clean hand?
      this.cleanThreshold_low = 0.6;
      this.cleanThreshold_high = 0.7;
      this.playClean = false;

      // Should we lock into a chow hand?
      this.playChowHand = false;

      // probability of chickening at any check.
      this.chickenThreshold = config.BOT_CHICKEN_THRESHOLD;
      this.chicken = false;

      // For our panic threshold, we pick "4 turns"
      // (out of a possible 18 "turns" in a hand).
      this.basePanicThreshold = 16;
      this.panicThreshold = this.basePanicThreshold;
    }

    /**
     * Check whether we should just start chickening.
     */
    checkChicken(tilesRemaining) {
      // already going for chickens?
      if (this.chicken) return;

      // panic mode?
      if (this.chickenThreshold < 1 && tilesRemaining < this.panicThreshold) {
        this.chickenThreshold += this.chickenThreshold;
      }

      if (config.PRNG.nextFloat() < this.chickenThreshold) {
        this.chicken = true;
        let notice = `player ${this.player.id} will be going for chicken hands at ${tilesRemaining} tiles left!`;
        //console.log(notice);
        config.log(notice);
      }
    }

    // utility function
    suit(t) { return (t/9)|0; }

    /**
     * Decide how panicky we are, based on the number
     * of draws we've seen for this hand so far.
     */
    setDraws(draws=0) {
      this.panicThreshold = this.basePanicThreshold + draws * this.basePanicThreshold;
      console.debug(`panic for ${this.player.id} set to ${this.panicThreshold}`);
    }

    /**
     * Analyze the start tiles in a hand, to see what a
     * reasonable policy is going to be for these tiles.
     */
    determinePersonality() {
      // reset our chicken probability
      this.chickenThreshold = config.BOT_CHICKEN_THRESHOLD;
      this.chicken = false;

      // then check what we should do.
      this.analyse();
    }

    /**
     * Decide what an acceptable play policy is.
     */
    analyse() {
      let player = this.player;
      let stats = buildStatsContainer(player);

      // should we play clean?
      let most = max(...stats.suits);
      let total = stats.numerals;
      if (this.playClean === false && !this.stopClean && most/total > this.cleanThreshold_high) {
        this.playClean = stats.suits.indexOf(most);
        console.debug(`${player.id} will play clean (${this.playClean})`);
      }

      // if we're already playing clean, should we _stop_ playing clean?
      if (this.playClean !== false) {
        if (player.locked.length > 0) {
          let mismatch = player.locked.some(set => set[0].getTileFace() !== this.playClean);
          if (mismatch) { this.playClean = false; }
        }
        if (most/total < this.cleanThreshold_low) { this.playClean = false; }
        if (this.playClean === false) {
          this.stopClean = true;
          console.debug(`${player.id} will stop trying to play clean.`);
        }
      }

      // if we haven't locked anything yet, is this gearing up to be a chow hand?
      if (!player.locked.length) {
        let chowScore = stats.cpairs/2 + stats.chows;
        this.playChowHand = (stats.honours <=3 &&  chowScore >= 2 && stats.pungs < stats.chows);
        // note that this is a fluid check until we claim something, when it locks.
      }

      /**
       * THIS CODE HAS BEEN COMMENTED OFF BECAUSE IT IS SUPER SLOW.
       *
       * // Also have a look at possible score improvements
       * let scoring = this.player.rules.determineImprovement(this.player);
       *
       **/

      return stats;
    }

    /**
     * Do we want a particular tile?
     */
    want(tileNumber, reason, tilesRemaining) {
      this.checkChicken(tilesRemaining);

      // Are we the fowlest of chickens?
      if (this.chicken) {
        console.debug(this.player.id,'is going for chickens');
        return true;
      }

      // If we get here, we need to actually decide what our play policy for this tile is.
      let stats = this.analyse();
      if (false === this.checkClean(tileNumber, reason, tilesRemaining)) return false;
      if (!this.checkChow(tileNumber, reason, tilesRemaining, stats)) return false;
      if (!this.checkPung(tileNumber, reason, tilesRemaining, stats)) return false;

      // if we get here, nothing has ruled out this claim.
      return true;
    }

    /**
     * Would claiming this tile violate our clean policy? (if we don't have
     * one set, then obviously the answer is "no").
     */
    checkClean(tileNumber, reason, tilesRemaining, stats=false) {
      // Did we decide to play clean (i.e. any numbers in our hand must all be from the same suit)
      if (this.playClean!==false && tileNumber < 27) {
        let tilesuit = this.suit(tileNumber);
        if (tilesuit !== this.playClean) {
          console.debug(this.player.id, 'not claiming ',tileNumber,'due to playing clean','(',tilesRemaining,'left)');
          return false;
        }
      }

      // Secondary check: the tile itself is fine, but is the rest of our hand clean?
      if (stats) {
        console.debug(this.player.id, `checkClean with stats`. stats);

        let scount = stats.suits.reduce((t,v) => v>0 ? t+1 : t, 0);
        if (scount > 1) {
          console.debug(this.player.id, `trying to win clean, so we can't claim ${tileNumber} to win`);
          console.debug(this.player.id, this.playClean, tileNumber);
          // of course, only allow chows and better.
          if (reason >= CLAIM$1.CHOW) {
            console.debug(this.player.id, `claim ${reason}`);
            return reason;
          }
          console.debug(this.player.id, `no claim`);
          return false;
        }
      }

      return true;
    }

    /**
     * Can we declare a chow, given the play policy we've settled on at this point?
     */
    checkChow(tileNumber, reason, tilesRemaining, stats) {
      // Try not to chicken, part 1: don't go for chows if we're already playing pungs.
      if (CLAIM$1.CHOW <= reason && reason < CLAIM$1.PUNG) {
        let canChicken = this.allowScoringChicken && (stats.bigpungs > 0 || stats.locked.bigpungs > 0);

        if (stats.locked.pungs > 0 && !canChicken) {
          console.debug(this.player.id,'not claiming chow because we have a pung','(',tilesRemaining,'left)');
          return false;
        }
      }
      return true;
    }

    /**
     * Can we declare a pung/kong, given the play policy we've settled on at this point?
     */
    checkPung(tileNumber, reason, tilesRemaining, stats) {
      // Try not to chicken, part 2 don't go for pungs if we're going for a chow hand
      if (reason === CLAIM$1.PUNG || reason === CLAIM$1.KONG) {
        let canChicken =  this.allowScoringChicken && (stats.bigpungs > 0 || stats.locked.bigpungs > 0);
        let isBig = (tileNumber + 27 === this.player.wind) || (tileNumber + 27 === this.player.windOfTheRound) || (tileNumber > 30);

        if ((this.playChowHand || stats.locked.chows) > 0 && !canChicken && !isBig) {
          console.debug(this.player.id,'not claiming pung/kong because we have a chow, and',tileNumber,'is not scoring','(',tilesRemaining,'left)');
          return false;
        }
      }
      return true;
    }

    /**
     * Do we want to win on a particular tile?
     */
    determineWhetherToWin(tileNumber, reason, tilesRemaining) {
      this.checkChicken(tilesRemaining);

      // Are we still the fowlest of chickens?
      if (this.chicken) {
        console.debug(this.player.id,'is going for chickens');
        return true;
      }

      // If we get here, we need to actually decide what our play policy for this tile is.
      let stats = this.analyse();

      // Note that the "clean play" check is a little different compared to what
      // happens in the `want()` function: when we're deciding to win, we need
      // to check not just whether "this tile" is clean, but also whether the
      // rest of our hand is clean. If it's not, this might still be a good claim
      // to make (e.g. pung of dragons), so instead of saying "we don't want this"
      // we say "we don't want to WIN on this, but we want it, for the reason that
      // you were going to use to win".
      let cleancheck = this.checkClean(tileNumber, reason, tilesRemaining, stats);
      if (cleancheck !== true) return cleancheck;

      // the regular chow/pung checks are still the same though.
      if (!this.checkChow(tileNumber, reason, tilesRemaining, stats)) return false;
      if (!this.checkPung(tileNumber, reason, tilesRemaining, stats)) return false;

      // if we get here, nothing has ruled out this claim.
      return true;
    }

    /**
     * When this function is called, the player HAS a winning hand,
     * but it doesn't know whether it's valid in terms of play policy
     * yet (e.g. winning on a chow when going for a pung hand).
     */
    isValidWin(tilesRemaining) {
      this.checkChicken(tilesRemaining);

      // Are we continuing to be the fowlest of chickens?
      if (this.chicken) {
        console.debug(this.player.id,'is going for chickens');
        return true;
      }

      let stats = this.analyse();
      let canChicken =  this.allowScoringChicken && (stats.bigpungs > 0 || stats.locked.bigpungs > 0);

      // if we're playing clean, is our hand clean?
      let scount = stats.suits.reduce((t,v) => v>0 ? t+1 : t, 0);
      console.debug(this.player.id, this.playClean, scount, stats);
      if (this.playClean !== false && scount > 1) {
        if (!canChicken) return false;
      }

      // if that's not an issue, are we mixing chows and pungs?
      if (stats.pungs>0 && stats.chows>0) {
        if (!canChicken) return false;
      }

      // if we get here, nothing has ruled out this win.
      return true;
    }

    /**
     * Is this tile, that is in our hand, a dead tile in terms of play
     * policy? E.g. is it a dots tile while we're trying to play clean
     * on the characters suit instead?
     */
    deadTile(tile, tilesRemaining) {
      this.checkChicken(tilesRemaining);

      // all tiles are welcome in a chicken hand.
      if (this.chicken) return false;

      // is this in a suit we want to get rid of?
      if (this.playClean !== false && tile < 27) {
        let suit = this.suit(tile);
        if (this.playClean !== suit) {
          // return how many of this suit we're going to get rid of.
          return this.player.tiles.map(t => this.suit(t.getTileFace())).filter(s => s===suit).length;
        }
      }

      // is this tile part of a concealed pung,
      // while we're going for a chow hand?
      let stats = this.analyse();
      if (stats.locked.chows > 0 && stats.counts[tile] > 2) {
        return true;
      }

      return false;
    }
  }

  /**
   * This guy should be obvious: bots are simply
   * automated processes that follow play rules
   * and simply do what the code says to do.
   */
  class BotPlayer extends Player {
    constructor(id, chicken=false) {
      super(id);
      this.personality = new Personality(this);
      this.chicken = chicken;

      // Don't bind this function unless the config says we should.
      if (config.FORCE_OPEN_BOT_PLAY) this.enableShowTilesAnyway();
    }

    /**
     * Inform the personality object how many draws
     * we've seen for the hand we're about to play,
     * because that will change how much we'll be
     * willing to go harder-to-achieve hands.
     */
    reset(hand, wind, windOfTheRound, draws) {
      super.reset(hand, wind, windOfTheRound, draws);
      if (this.personality) {
        this.personality.setDraws(this.draws);
        if (this.chicken) this.personality.chicken = true;
      }
    }

    // We only assign this a function body in the constructor,
    // and use an empty function so that calls don't error out.
    showTilesAnyway() {}

    // And this is where we do that assigning.
    enableShowTilesAnyway() {
      this.showTilesAnyway = () => {
        if (!config.FORCE_OPEN_BOT_PLAY) return;
        if (globalThis.PLAYER_BANKS && this.id !== 0) {
          let bank = globalThis.PLAYER_BANKS[this.id];
          bank.innerHTML = '';
          this.getTileFaces().forEach(t => { t = create(t); bank.appendChild(t); });
          this.locked.forEach((s,sid) => {
            s.forEach(t => {
              t.lock(1 + sid);
              bank.appendChild(t);
            });
          });
          this.bonus.forEach(t => { t = create(t); t.lock(); bank.appendChild(t); });
          if (this.waiting) bank.classList.add('waiting'); else bank.classList.remove('waiting');
          globalThis.PLAYER_BANKS.sortTiles(bank);
        }
      };
    }

    // pass-through for "show tiles anyway" functionality
    append(tile, claimed, supplement) {
      let _ = super.append(tile, claimed, supplement);
      this.showTilesAnyway();
      return _;
    }

    // pass-through for "show tiles anyway" functionality
    remove(tile) {
      super.remove(tile);
      this.showTilesAnyway();
    }

    /**
     * When real play is about to start, examine our start
     * tiles to determine the kind of plays we'll make.
     */
    playWillStart() {
      super.playWillStart();
      this.personality.determinePersonality();
    }

    /**
     * This is the override for the function that Player calls in order
     * to determine which tile to remove from the hand. The `resolve` function
     * is a promise callback that will allow the game to "unpause" itself.
     *
     * Bot discards are based on what can be meaningfully formed with the
     * tiles currently in hand, and throwing out the tile that contributes
     * the least. Tile availability based on the bot's local knowledge of
     * which tiles might still be available in the game is used to determine
     * whether things like pairs or chows can still be formed.
     *
     * Additionally, the tile value is balanced against its score potential.
     * For example, in a one-suit hand that also has a set of a second suit,
     * the potential payoff for getting rid of that already formed set may
     * outweigh the fact that the tiles involved are already contributing
     * to winning the hand.
     *
     * Note: returning an falsey value leads to the game understanding that
     * as meaning this play has won.
     */
    determineDiscard(tilesRemaining, resolve, showAllSuggestions) {
      // If we were awarded a winning claim, then by the
      // time we are asked to discard, we will already be
      // marked as having won:
      if (this.has_won) return resolve(undefined);

      // we only consider tiles that we can legally play with, meaning
      // (obvious) not bonus tiles, and not any tile already involved
      // in a play-claim earlier.
      let tiles = this.getAvailableTiles();

      // if we have no concealed tiles, that means it became our turn by
      // declaring a win off of a discard. So... don't discard!
      if (!tiles.length) return resolve(undefined);

      // If we have concealed tiles still, did the tile we just received
      // actually make us win?
      let { winpaths } = this.tilesNeeded();

      if(winpaths.length > 0) {
        // We may very well have won! ...except not if our play policy
        // has requirements that this win is not allowed under.
        if (this.personality.isValidWin(tilesRemaining)) {
          // We have indeed won! Mark this as a self-drawn win, but only
          // if `this.lastClaim` is false, because it's possible that we
          // reach this code from someone claiming the set they needed,
          // instead of saying it was a win, at which point this code
          // will detect they have (of course) won. That should NOT be
          // a self-drawn win, of course.
          //
          // However, if this was a normal claimed win (by clicking "win"
          // as claim type) then we would have exited `determineDiscard`
          // already (due to `this.has_won`), and then the game.js game
          // loop will discover we've won by the fact that this player
          // is opting not to discard anything.
          if (!this.lastClaim) {
            this.selfdraw = true;
            console.debug(`Self-drawn win for player ${this.id} on ${this.latest.getTileFace()}`);
          }
          return resolve(undefined);
        }
        // If we get here, we have not won.
        this.waiting = false;
      }

      // If we're waiting to win, then this was not (one of)
      // our winning tile(s), so in the absence of determining
      // whether something would be more points, we immediately
      // get rid of this tile again.
      if (this.waiting) return resolve(this.determineWhatToWaitFor());

      // Did we self-draw a limit hand?
      let allTiles = this.getTileFaces(true).filter(t => t<34);
      let limithand = this.rules.checkForLimit(allTiles);
      if (limithand) return resolve(undefined);

      // Now then. We haven't won, let's figure out which tiles are worth keeping,
      // and which tiles are worth throwing away.
      this.determineDiscardCarefully(tilesRemaining, resolve, showAllSuggestions);
    }

    /**
     * If we're waiting on a pair, then we can throw out either the
     * tile we already had, or the tile we just got. So, decide on
     * which to throw based on how nice the tile is for the hand.
     *
     * If we're _not_ waiting on a pair, but we reached this
     * function, then we're simply not interested in the tile we
     * just picked up: get rid of it.
     */
    determineWhatToWaitFor() {
      console.debug(this.id,"waiting to win but",this.latest,"is not in our wait list",this.waiting);

      let winTiles = Object.keys(this.waiting);
      if (winTiles.length === 1) {
        let tileNumber = (winTiles[0]|0); // remember: object keys are strings, but we need a number!
        let ways = this.waiting[tileNumber];

        if (ways.length === 1 && ways[0] === "32s1") {
          // Waiting on a pair: do some checking
          let had = this.getSingleTileFromHand(tileNumber);
          let received = this.latest;
          console.debug(`${this.id} has two singles in hand:`, had, received);
          let tile = this.determineWhichPairTileToThrow(had, received);
          console.debug(`${this.id} wants to throw out:`, tile);

          // If we throw out the tile we already had, then we'll have to update
          // our "waiting" object so it's set to wait for the right tile.
          if (tile === had) {
            let nid = received.getTileFace();
            let oid = had.getTileFace();
            console.debug(`${this.id} swapping win information from ${oid} to ${nid}`);
            this.waiting[nid] = this.waiting[oid];
            delete this.waiting[oid];
            console.debug(`${this.id} post-swap:`, this.waiting);
          }
          return tile;
        }
      }

      // Not waiting on a pair: get rid of this tile.
      return this.latest;
    }

    /**
     * Determine what the inate value of a tile is in terms
     * of using it to win on a pair, given the rest of our hand.
     */
    determineWhichPairTileToThrow(had, received) {
      // absolute base step 1: can we even GET another copy of this tile?
      if (this.tracker.get(had.getTileFace()) === 0) return had;
      if (this.tracker.get(received.getTileFace()) === 0) return received;

      // If both tiles are viable pair tiles, we check some more things.
      let tiles = this.getAvailableTiles(true).slice();
      let pos = tiles.indexOf(had);
      tiles.splice(pos,1);

      // For instance: is one of these tiles nicer for our suit composition?
      let suits = [0, 0, 0, 0, 0];
      tiles.forEach(tile => {
        suits[tile.getTileSuit()]++;
      });
      let hsuit = had.getTileSuit();
      let rsuit = received.getTileSuit();
      // If either tile "introduces a new suit", get rid of it.
      if (hsuit < 3 && suits[hsuit] === 0) return had;
      if (rsuit < 3 && suits[rsuit] === 0) return received;

      // if not, going out on a major pair is always nicer
      let hnum = had.getTileFace();
      let rnum = received.getTileFace();
      if (hnum > 26) {
        if (rnum > 26) {
          // keep any dragon, player wind, or wind of the round.
          if (hnum > 30) return received;
          if (hnum === 27 + this.wind) return received;
          if (hnum === 27 + this.windOfTheRound) return received;
          // if the tile was had was none of those, is the received tile?
          if (rnum > 30) return had;
          if (rnum === 27 + this.wind) return had;
          if (rnum === 27 + this.windOfTheRound) return had;
          // okay, so at this point it doesn't matter: just stick with what we had.
          return received;
        }
        return received;
      }

      if (rnum > 26) return had;

      // If we get here, it also doesn't matter: stick with what we had.
      return received;
    }

    /**
     * This is the second part of determineDiscard, which handles all
     * the "we didn't just win" cases.
     */
    determineDiscardCarefully(tilesRemaining, resolve, showAllSuggestions) {
      let tiles = this.getAvailableTiles();
      let tileCount = [];
      let immediateValue = [];

      // First, let's see how many of each tile we have.
      let faces = Array.from(tiles).map(tile => {
        let id = tile.getTileFace();
        if (!tileCount[id]) { tileCount[id] = 0; }
        tileCount[id]++;
        return id;
      });

      // Cool. With that sorted out, let's start ranking
      // tiles in terms of how valuable they are to us.
      faces.forEach(tile => {
        let value = 0;
        let availability = this.tracker.get(tile);

        // Step 1: are there any tiles that our play policy
        // says need to go? If so, discard any of those.
        let deadScore = this.personality.deadTile(tile, tilesRemaining);
        if (deadScore) return (immediateValue[tile] = deadScore);

        // Step 2: our play policy has nothing to say here,
        // so values are based on "can we get more". If not,
        // then however many tile we have is all we'll get.

        if (tileCount[tile] >= 3) value = max(value, availability>0 ? 100 : 90);
        else if (tileCount[tile] === 2) value = max(value, availability>0 ? 90 : 50);
        else if (tileCount[tile] === 1) {
          // numeral might lead to a chow?
          if (tile < 27)
            value = max(value, this.determineDiscardValueForChow(value, tile, tileCount));

          // scoring honours are good
          if (tile === 27 + this.wind || tile === 27 + this.windOfTheRound || tile > 30)
            value = max(value, availability > 0 ? 45 : 0);

          // double scoring wind is _really_ good
          if (tile === 27 + this.wind && tile === 27 + this.windOfTheRound)
            value = max(value, availability > 0 ? 60 : 0);

          // we've run out of special cases
          //value = max(value, availability ? 40 : 0);
        }

        // Record the (by definition) highest value for this tile.
        immediateValue[tile] = value;
      });

      // We will find the lowest scoring tile, and discard that one
      let sorted = immediateValue.map((score, tile) => ({ tile, score })).sort((a,b) => {
        let diff = (a.score - b.score);
        if (diff !== 0) return diff;
        return (a.tile - b.tile);
      });

      let lowest = sorted[0];
      let candidates = sorted.filter(v => v.score===lowest.score);

      // did we need to generate all, or just one, discard?
      if (showAllSuggestions) {
        return resolve(candidates.map(candidate => this.getSingleTileFromHand(candidate.tile)));
      }

      let idx = Math.floor(config.PRNG.nextFloat() * candidates.length);
      let candidate = candidates[idx].tile;
      resolve(this.getSingleTileFromHand(candidate));
    }

    /**
     * determineDiscard helper function dedicated to determining
     * whether chows are an option or not.
     */
    determineDiscardValueForChow(value, tile, tileCount) {
      let face = tile % 9;
      let m2 = face > 1 && tileCount[tile - 2];
      let m1 = face > 0 && tileCount[tile - 1];
      let p1 = face < 8 && tileCount[tile + 1];
      let p2 = face < 7 && tileCount[tile + 2];
      let m2a = this.tracker.get(tile - 2);
      let m1a = this.tracker.get(tile - 1);
      let p1a = this.tracker.get(tile + 1);
      let p2a = this.tracker.get(tile + 2);

      // X?? chow check
      if (face<7) {
        if (p1 && p2) value = max(value, 90); // already in hand
        else if (p1 && p2a) value = max(value, 80); // possible
        else if (p1a && p2) value = max(value, 70); // possible (gap)
      }

      // ?X? chow check
      if (face>0 && face<8) {
        if (m1 && p1) value = max(value, 90); // already in hand
        else if (m1 && p1a) value = max(value, 80); // possible
        else if (m1a && p1) value = max(value, 80); // possible
      }

      // ??X chow check
      if (face>1) {
        if (m2 && m1) value = max(value, 90); // already in hand
        else if (m2 && m1a) value = max(value, 70); // possible (gap)
        else if (m2a && m1) value = max(value, 80); // possible
      }

      if (value===0) {
        // if this tile is not involved in a chow, connected pair,
        // or gapped pair, then its sequential score is some low
        // value, inversely related to how close it is to its
        // nearest in-suit neighbour. And if there are none, then
        // its value in the hand is zero.
        for (let i=3, c1, c2; i<=8; i++) {
          c1 = tileCount[tile-i] && ((tile-i)%9 < face);
          c2 = tileCount[tile+i] && ((tile+i)%9 > face);
          if (c1 || c2) return 8 - i;
        }
      }

      return value;
    }

    /**
     * Automated claim policy
     */
    async determineClaim(pid, discard, tilesRemaining, resolve, interrupt, claimTimer) {
      let ignore = {claimtype: CLAIM$1.IGNORE};
      let tile = discard.getTileFace();
      let mayChow = this.mayChow(pid);
      let tiles = this.getTileFaces();
      tiles.sort();

      let {lookout, waiting} = this.tilesNeeded();

      // Do these tiles constitute a "waiting to win" pattern?
      if (waiting) {

        let winTiles = {};
        lookout.forEach((list,tileNumber) => {
          if (list) {
            list = list.filter(v => v.indexOf('32') === 0);
            if (list.length) winTiles[tileNumber] = list;
          }
        });
        this.markWaiting(winTiles);

        console.debug(this.id, 'waiting to win', winTiles, this. getTileFaces(), this.getLockedTileFaces(), 'tile',tile,'in list?', winTiles[tile]);

        // If this is not (one of) the tile(s) we need, ignore it, unless we can form a kong.
        let ways = winTiles[tile] || [];

        if (!ways.length) {
          if (lookout[tile] && lookout[tile].indexOf('16') !== -1) {
            // but, *should* we kong?
            let allowed = this.personality.want(tile, CLAIM$1.KONG, tilesRemaining);
            console.debug(`${this.id} wants to claim a kong ${tile} - allowed by policy? ${allowed}`);
            if (allowed) return resolve({claimtype: CLAIM$1.KONG });
          }
          resolve(ignore);
        }

        else {
          // (one of) the tile(s) we need: claim a win, if we can.
          let wintype = ways.map(v => parseInt(v.substring(3))).sort((a,b)=>(b-a))[0];
          let allowed = this.personality.determineWhetherToWin(tile, wintype, tilesRemaining);
          if (allowed === false) return resolve(ignore);
          if (allowed === wintype) {
            // When the result of determineWhetherToWin is a claim constant,
            // then we can't win on this tile due to policy violations (e.g.
            // trying win on pung of winds while we're not clean yet), but
            // this IS a valid regular claim as far as our play policy is
            // concerned, so resolve it as such.
            if (CLAIM$1.CHOW <= allowed && allowed < CLAIM$1.PUNG && !mayChow) {
              // just remember that if the claim was a chow, that might not
              // actually be legal if we're not winning on this tile so make
              // sure to check for that.
              return resolve(ignore);
            }
            return resolve({claimtype: allowed });
          }
          return resolve({claimtype: CLAIM$1.WIN, wintype });
        }
      }


      // If we get here, we're NOT waiting to win: perform normal claim check.
      if (lookout[tile]) {
        let claims = lookout[tile].map(print => unhash$1(print,tile)).map(set => {
          let type = set.type;
          console.debug(`lookout for ${tile} = type: ${type}, mayChow: ${mayChow}`);
          if (type === Constants.CHOW1 || type === Constants.CHOW2 || type === Constants.CHOW3) {
            if (!mayChow) return;
          }
          if(!this.personality.want(tile, type, tilesRemaining)) return false;
          if (type === CLAIM$1.WIN) wintype = set.subtype ? set.subtype : 'normal'; // FIXME: TODO: is this check still necessary, given "waiting" above?
          return { claimtype: type };
        });

        // filter, order highest-to-lowest, and then return the first element if there is one.
        claims = claims.filter(v => v).sort((a,b) => (b.claimtype - a.claimtype));
        if (!claims.length) return resolve(ignore);
        return resolve(claims[0]);
      }

      return resolve(ignore);
    }

    /**
     * Check whether this player has, and if so,
     * wants to declare, a kong.
     */
    async checkKong() {
      // players with a UI get to decide what to do on their own turn.
      if (this.ui && !config.BOT_PLAY) return false;

      // does this player have a kong in hand that needs to be declared?
      let tiles = this.getTileFaces();
      let counts = new Array(34).fill(0);
      tiles.forEach(t => counts[t]++);
      for (let tile=0, e=34, count; tile<e; tile++) {
        count = counts[tile];
        if (count===4) {
          // TODO: check with this.personality to determine whether to kong or not.
          let tiles = this.tiles.filter(t => t.getTileFace()==tile);
          this.lockClaim(tiles);
          return tiles;
        }
      }
      return false;
    }

    /**
     * See if this bot wants to rob the kong that was
     * just played in order to win the current hand.
     */
    robKong(pid, tiles, tilesRemaining, resolve) {
      // Rob this kong?
      let { lookout, waiting } = this.tilesNeeded();
      if (waiting) {
        let tile = tiles[0].getTileFace();
        let need = lookout[tile];
        if (need && need.some(v => v.indexOf('32')===0)) {
          // get the win calls, and remove their win marker
          let reasons = need.filter(v => v.indexOf('32')===0).map(v => parseInt(v.replace('32s','')));
          if (reasons.length > 0) {
            let reason = reasons[0];

            if (reasons.length > 1) {
              // all of these are valid wins, but some will score better than others.
              reasons.sort((a,b)=>(a-b));
              // pairs are always best, but if we can't win on a pair, and the first
              // reason is not a pung, we might have chow/pung competition
              reason = reasons[0];
              if (reason >= CLAIM$1.CHOW && reason <= CLAIM$1.PUNG) {
                if (reasons.indexOf(CLAIM$1.PUNG) > 0) {
                  let chows = true;
                  let pungs = true;
                  this.locked.forEach(set => {
                    if (set[0].getTileFace() !== set[1].getTileFace()) pungs = false;
                    else chows = false;
                  });
                  if (chows && !pungs) { reason = reasons[0]; } // chow-only
                  if (!chows && pungs) { reason = CLAIM$1.PUNG; } // pung-only
                  if (!chows && !pungs) { reason = CLAIM$1.PUNG; } // mixed, go for the pung
                }
              }
            }

            if (this.personality.determineWhetherToWin(tile, reason, tilesRemaining)) return resolve({
              claimtype: CLAIM$1.WIN,
              wintype: reason,
              from: pid,
              tile: tile,
              by: this.id
            });
          }
        }
      }
      resolve();
    }
  }

  const filenames = {
    thud: [
      `play-01.mp3`,
      `play-02.mp3`,
      `play-03.mp3`,
      `play-04.mp3`,
      `play-05.mp3`,
      `play-06.mp3`,
      `play-07.mp3`,
    ],

    click: [
      `click-01.mp3`,
      `click-02.mp3`,
      `click-03.mp3`,
      `click2-01.mp3`,
      `click2-02.mp3`,
    ],

    multi: [`click-multi-01.mp3`, `click-multi-02.mp3`, `click-multi-03.mp3`],

    kong: [`click-multi-large-01.mp3`, `click-multi-large-02.mp3`],

    start: [`start.mp3`],
    win: [`win.mp3`],
    draw: [`draw.mp3`],
    end: [`end.mp3`],
  };

  // turn filenames into playable clips:
  const buildBin = (filename) => {
    let audio = document.createElement("audio");
    audio.src = `audio/${filename}`;
    audio.type = `mp3`;
    return audio;
  };

  const clips = {};

  Object.keys(filenames).forEach(
    (bin) => (clips[bin] = filenames[bin].map(buildBin))
  );

  /**
   * play a random clip from the specified named bin,
   * if `id` is falsey. Otherwise, play that specific
   * clip.
   */
  function playClip(name, id) {
    if (!config.USE_SOUND) return;

    let bin = clips[name];
    if (!bin) {
      return console.error(`audio bin ${name} does not exist`);
    }

    let pos = random(bin.length);
    let audio = bin[pos];
    if (!audio) {
      return console.error(`audio bin ${name} does not have a clip ${pos}`);
    }

    audio.cloneNode().play();

    // cloneNode is used here to make sure that the same
    // clip can be played "while it is already playing",
    // e.g. a randomised tile play a sound that happens to
    // pick the same clip in the sequence should not "cut
    // off" playback of that same file.
  }

  /**
   * A dedicated bit of code for rotating the winds as hands are played.
   */
  const rotateWinds = (function generateRotateWindsFunction() {
    const winds = Array.from(document.querySelectorAll('.player-wind'));
    const indicator = document.querySelector('.windicator');
    const handcount = indicator.querySelector('.hand-counter');

    let previous = 0;

    /**
     * This is the function that is exposed to UI code, and effects
     * the rotation of the player winds, and shifting the wind of
     * the round when appropriate.
     */
    function rotateWinds(rules, wind=false, wotr=false, hand='', draws='') {
      // we mark which round, hand, and replay this is:
      handcount.innerHTML = `round ${1+wotr}<br>hand ${hand}`;
      if (draws) { handcount.innerHTML += `<br>rtr ${draws}`; }

      // determine what the hand wind would be, and if it's the
      // same as last round's we don't update anything, because
      // nothing has changed.
      let h = (wotr*4 + wind);
      if (h===previous) return;

      // if the hand wind id is a different id, rotate the winds!
      previous = h;
      let p = (((h/4)|0)%4);
      let offset = (2 * p);

      indicator.style.setProperty('--slide', offset + 'em');

      // rotate counter clockwise if the rules say we should.
      if (rules.reverse_wind_direction) {
        winds.forEach(e => {
               if (e.classList.contains('tc')) { e.classList.remove('tc'); e.classList.add('lc'); }
          else if (e.classList.contains('rc')) { e.classList.remove('rc'); e.classList.add('tc'); }
          else if (e.classList.contains('bc')) { e.classList.remove('bc'); e.classList.add('rc'); }
          else if (e.classList.contains('lc')) { e.classList.remove('lc'); e.classList.add('bc'); }
        });
      }

      // otherwise, rotate the winds clockwise.
      else {
        winds.forEach(e => {
              if (e.classList.contains('tc')) { e.classList.remove('tc'); e.classList.add('rc'); }
          else if (e.classList.contains('rc')) { e.classList.remove('rc'); e.classList.add('bc'); }
          else if (e.classList.contains('bc')) { e.classList.remove('bc'); e.classList.add('lc'); }
          else if (e.classList.contains('lc')) { e.classList.remove('lc'); e.classList.add('tc'); }
        });
      }
    }

    rotateWinds.reset = function() {
      previous = 0;
      indicator.style.setProperty('--slide', '0em');
      winds[0].setAttribute('class', 'player-wind tc e');
      winds[1].setAttribute('class', 'player-wind rc');
      winds[2].setAttribute('class', 'player-wind bc');
      winds[3].setAttribute('class', 'player-wind lc');
      indicator.classList.remove('done');
    };

    rotateWinds.done = function() {
      return (indicator.classList.add('done'));
    };

    // and of course, make sure to remember to expose that function...
    return rotateWinds;
  })();

  /**
   * This is a graphical interface that players can use
   * to visualise their game knowledge, and allow external
   * interaction (human overrides for bots, or just plain
   * human input for... well, humans)
   */
  class ClientUIMaster {
    constructor(player, tracker) {
      this.player = player;
      this.tracker = tracker;
      this.tracker.setUI(this);
      this.id = player.id;
      this.discards = document.querySelector(`.discards`);
      this.playerbanks = document.querySelectorAll(`.player`);
      this.knowledge = document.querySelector(`.knowledge`);
      this.settings = document.querySelector(`.settings`);
      this.theming = document.querySelector(`.theming`);

      this.gameBoard = document.querySelector(`.board`);
      if (config.PAUSE_ON_BLUR) {
        this.gameBoard.addEventListener(`blur`, async (evt) => {
          let resume = await this.player.game.pause();

          let handleResume = () => {
            this.gameBoard.removeEventListener(`focus`, handleResume);
            resume();
            this.pause_protection = true;
          };

          this.gameBoard.addEventListener(`focus`, handleResume);
        });
      }

      this.settings.addEventListener(`click`, () => modal.pickPlaySettings());
      this.theming.addEventListener(`click`, () => modal.pickTheming());

      this.el = this.playerbanks[this.id];
      this.reset(0,0);

      // Super debug setting: allows bots to tap directly
      // into the player`s UI. This is super bad, but for
      // development purposes, rather required.
      if (config.FORCE_OPEN_BOT_PLAY) {
        globalThis.PLAYER_BANKS = this.playerbanks;
        globalThis.PLAYER_BANKS.sortTiles = e => this.sortTiles(e);
      }
    }

    /**
     * ...docs go here...
     */
    reset(wind, windOfTheRound, hand, draws) {
      if(!this.el) return;

      this.el.setAttribute(`class`, `player`);
      this.playerbanks.forEach(b => {
        b.innerHTML = ``;
        b.setAttribute(`class`, `player`);
      });
      this.el.innerHTML = ``;

      let discards = this.discards;
      discards.innerHTML = ``;
      discards.setAttribute(`class`, `discards`);

      this.bar = document.createElement(`div`);
      this.bar.classList.add(`countdown-bar`);
      this.discards.appendChild(this.bar);

      if (this.countdownTimer) this.countdownTimer.cancel();
      this.countdownTimer = false;

      rotateWinds(this.rules, wind, windOfTheRound, hand, draws);
    }

    /**
     * Reset the player`s tile tracker panel
     */
    resetTracker(tiles) {
      if (!this.knowledge) return; // happens when initialised before the DOM

      this.knowledge.innerHTML = ``;

      Object.keys(tiles).forEach(tile => {
        let div = document.createElement(`div`);
        div.classList.add(`tile-count`);
        if (tile>33) div.classList.add(`hidden`);
        for(let i=0; i<4; i++) {
          let e = create(tile);
          div.appendChild(e);
        }
        this.knowledge.appendChild(div);
      });
    }

    /**
     * Remove a tile from the tile tracker panel.
     */
    reduceTracker(tileNumber) {
      if (tileNumber > 33) return; // don`t track bonus tiles explicitly
      let tile = this.knowledge.querySelector(`game-tile[tile='${tileNumber}']`);
      tile.remove();
    }

    /**
     * Bind the rules to this UI, which can be handy for
     * things like generating a rules/scoring explanation.
     */
    setRules(rules) {
      this.rules = rules;
    }

    /**
     * Effect a lock on the UI. Note that UI elements can still
     * listen for events like document.blur etc. on their own.
     */
    pause(lock) {
      this.paused = lock;
      if (this.countdownTimer) { this.countdownTimer.pause(); }
      // don`t mark as paused if the modal dialogs are open
      if (modal.isHidden()) {
        this.discards.classList.add(`paused`);
      }
    }

    /**
     * Release the lock on the UI.
     */
    resume() {
      this.discards.classList.remove(`paused`);
      if (this.countdownTimer) { this.countdownTimer.resume(); }
      this.paused = false;
    }

    /**
     * If we need to do anything once the claim timer
     * ticks over, that can get bound here.
     */
    setClaimTimerCleanup(fn) {
      this.claimCleanup = fn;
    }

    /**
     * Start a count-down bar that signals to the user
     * that there is `some time remaining` without
     * giving them (milli)second accurate numbers.
     */
    startCountDown(ms) {
      new TaskTimer(
        timer => {
          this.countdownTimer = timer;
        },
        () => {
          this.countdownTimer = false;
        },
        ms,
        (count) => {
          let fraction = count===10 ? 1 : count/10;
          this.bar.style.width = `${100 - 100 * fraction}%`;
          if (fraction === 1) {
            this.bar.classList.remove(`active`);
            this.countdownTimer = false;
            if (this.claimCleanup) this.claimCleanup();
            this.claimCleanup = false;
          }
        },
        10
      );

      this.bar.classList.add(`active`);
    }

    /**
     * Triggered at the start of the game, before any hand is
     * started, so that players can be reset properly if more
     * than one game is played consecutively.
     */
    gameWillStart() {
      rotateWinds.reset();
      playClip(`start`);
      this.playerbanks.forEach(b => {
        if (this.rules) b.dataset.score = this.rules.player_start_score;
        b.dataset.wins = 0;
      });
    }

    /**
     * Triggered after players have been dealt their initial
     * tiles, but before the first discard is prompted for.
     */
    handWillStart(redraw, resolve) {
      if (config.BOT_PLAY) return resolve();
      let heading = `Ready to start playing?`;
      if (redraw) heading = `Ready to replay hand?`;
      modal.choiceInput(heading, [{label: `ready!`,value: false}], resolve);
    }

    /**
     * Called right before play(), after all players have been given a chance
     * to declare any kongs, but right before the first player gets their
     * first player tile, to set up the first discard.
     */
    playWillStart() {
      // we don`t actually have any UI that needs to kick in at this point.
    }

    /**
     * Note how many tiles are left to be played with in the current hand.
     */
    markTilesLeft(remaining) {
      let ui = document.querySelector(`.wall.data`);
      ui.textContent = `${remaining} tiles left`;
    }

    /**
     * Have the player confirm whether they want to declare
     * a self-drawn kong or not.
     */
    async confirmKong(tile, resolve) {
      if (config.BOT_PLAY) return resolve(true);

      let cancel = () => resolve(false);
      modal.choiceInput(`Declare kong (${config.TILE_NAMES[tile]})?`, [
        { label: `Absolutely`, value: `yes` },
        { label: `No, I have plans for those tiles`, value: `no` },
      ], result => {
        if (result === `yes`) resolve(true);
        else resolve(false);
      }, cancel);
    }

    /**
     * Several actions require removing the most recent discard,
     * such as players claiming it to form sets from their hand.
     */
    removeLastDiscard() {
      if (this.discards.lastChild) {
        this.discards.removeChild(this.discards.lastChild);
      }
    }

    /**
     * Triggered when play moves from one player to another.
     */
    nextPlayer() {
      this.discards.lastChild.unmark(`selectable`);
    }

    /**
     * Utility function: checks if this player is holding (at least one of) this tile.
     */
    haveSingle(tile) {
      let tiles = this.getAllTilesInHand(tile.dataset ? tile.getTileFace() : tile);
      return tiles.length >= 1;
    }

    /**
     * Utility function: checks if this player can form a pung with this tile.
     */
    canPung(tile) {
      let tiles = this.getAllTilesInHand(tile.dataset ? tile.getTileFace() : tile);
      return tiles.length >= 2;
    }

    /**
     * Utility function: checks if this player can form a kong with this tile.
     */
    canKong(tile) {
      let tiles = this.getAllTilesInHand(tile.dataset ? tile.getTileFace() : tile);
      return tiles.length === 3;
    }

    /**
     * Utility function: checks if this player can form a particular type of
     * chow with this tile either as first, second, or third tile in the set.
     */
    canChow(tile, type) {
      tile = (tile.dataset ? tile.getTileFace() : tile);
      if (tile > 26) return false;
      let face = tile % 9;
      let t1, t2;
      if (type === CLAIM$1.CHOW1) {
        if (face > 6) return false;
        t1 = tile + 1;
        t2 = tile + 2;
      }
      if (type === CLAIM$1.CHOW2) {
        if (face===0 || face===8) return false;
        t1 = tile - 1;
        t2 = tile + 1;
      }
      if (type === CLAIM$1.CHOW3) {
        if (face < 2) return false;
        t1 = tile - 2;
        t2 = tile - 1;
      }
      return this.getSingleTileFromHand(t1) && this.getSingleTileFromHand(t2);
    }


    /**
     * Triggered when either the hand was a draw, or someone won,
     * with the full game disclosure available in case of a win.
     */
    endOfHand(disclosure, force_reveal_player=false) {
      if (!disclosure) {
        playClip(`draw`);
        this.discards.classList.add(`exhausted`);
        return;
      }

      if (!force_reveal_player) playClip(`win`);

      disclosure.forEach( (res,id) => {
        if (id == this.id && !force_reveal_player) return;
        let bank = this.playerbanks[id];
        bank.innerHTML = ``;
        bank.setAttribute(`class`, `player`);

        res.bonus.forEach(t => {
          t = create(t);
          t.bonus();
          bank.appendChild(t);
        });

        let locknum = 1 + this.getLockedTiles(bank).length;

        res.locked.forEach(s => {
          s.forEach(t => {
            let n = create(t.getTileFace());
            n.lock(locknum);
            if (t.isWinningTile()) n.winning();
            bank.appendChild(n);
          });
          locknum += s.length;
        });

        res.concealed.sort((a,b)=>(a-b)).forEach(t => bank.appendChild(create(t)));

        if (res.winner) {
          this.discards.classList.add(`winner`);
          bank.classList.add(`winner`);
        }

        bank.dataset.wincount = res.wincount;
        this.sortTiles(bank);
      });
    }

    /**
     * Triggered after all hands have been played and the game is over,
     * with the full score history for the game available for presenting
     * to the user.
     */
    endOfGame(scores) {
      rotateWinds.done();
      playClip(`end`);

      let v=0, b=-1;
      scores.forEach( (score,id) => { if (score>v) { v = score; b = id; }});
      this.playerbanks.forEach( (bank,id) => {
        bank.classList.remove(`waiting`);
        bank.classList.remove(`winner`);
        if (id===b) bank.classList.add(`game-winner`);
      });

      // clear out the player banks, discards, and tile tracker.
      let remove = [];
      this.playerbanks.forEach(bank => {
        remove = [...remove, ...bank.querySelectorAll(`game-tile`)];
      });
      remove = [...remove, ...this.discards.querySelectorAll(`game-tile`)];
      remove.forEach(t => t.parentNode.removeChild(t));

      // and then for aesthetic purposes, fill the player banks and tracker
      this.playerbanks.forEach(bank => {
        new Array(13).fill(-1).forEach(t => bank.appendChild(create(t)));
      });

      this.tracker.reset();
    }

    /**
     * Locally record the scores for a played hand.
     */
    recordScores(scores) {
      scores.forEach((score, b) => {
        let d = this.playerbanks[b].dataset;
        if (!d.score) d.score = 0;
        d.score = parseInt(d.score) + score;
      });
    }

    /**
     * At the end of the game, people can go through the scores
     * and see which tiles weres associated with that.
     */
    loadHandPostGame(disclosure) {
      this.endOfHand(disclosure, true);
    }

    /**
     * Triggered at the start of a hand, stating which
     * hand this is, and what its wind of the round is.
     */
    markHand(hand, wind) {
      this.el.dataset.wind = [`東`,`南`,`西`,`北`][wind];
    }

    /**
     * Mark the player with `id` as the currently active player.
     */
    activate(id) {
      this.playerbanks.forEach(bank => bank.classList.remove(`active`));
      this.playerbanks[id].classList.add(`active`);
      if (id != this.id) {
        let latest = this.el.querySelector(`game-tile.latest`);
        if (latest) latest.unmark(`latest`);
      }
    }

    /**
     * Visually unmark this player as active (this function is
     * called specifically on whoever is currently activ)
     */
    disable() {
      this.el.classList.remove(`active`);
    }

    /**
     * Visually mark this player as waiting to win.
     */
    markWaiting(val) {
      if (val) this.el.classList.add(`waiting`);
      else this.el.classList.remove(`waiting`);
    }

    /**
     * Visually mark this player as having won.
     */
    markWinner(wincount) {
      this.el.dataset.wincount = wincount;
      this.el.classList.add(`winner`);
      this.el.classList.remove(`active`);
    }

    /**
     * Add a tile to this player`s tilebank.
     */
    append(t) {
      let old = this.el.querySelector(`game-tile.latest`);
      if (old) {
        old.unmark(`latest`);
        old.setTitle(``);
      }
      if (!t.isLocked()) {
        t.mark(`latest`);
        t.setTitle(`latest tile`);
      }
      this.el.appendChild(t);
      this.sortTiles();
    }

    /**
     * Remove a tile from this player`s tile bank
     */
    remove(tile) {
      this.el.removeChild(tile);
    }

    /**
     * Show this player as locking down a set formed
     * from tiles in their hand, and the current discard
     */
    lockClaim(tiles) {
      playClip(tiles.length===4 ? `kong` : `multi`);

      this.removeLastDiscard();
      let locknum = 1 + this.getLockedTiles().length;
      tiles.forEach(tile => {
        tile.lock(locknum);
        this.append(tile);
      });
      this.sortTiles();
    }

    /**
     * Move the fourth tile in a locked set of three from the
     * player`s hand to that locked set.
     */
    meldKong(tile) {
      // find another tile like this, but locked, which can only be a pung.
      let other = this.el.querySelector(`game-tile[locked][tile='${tile.getTileFace()}']`);
      tile.lock(other.getLockNumber());
      this.el.appendChild(tile);
      this.sortTiles();
    }

    /**
     * Triggered when a player discards a tile from their hand.
     */
    playerDiscarded(player, tile, playcounter) {
      playClip(playcounter===1 ? `thud` : `click`);

      let bank = this.playerbanks[player.id];

      console.debug(`${this.id} sees discard ${tile} from ${player.id}`);

      if (player.id != this.id) {
        let blank = bank.querySelector(`[tile='-1']`);
        if (blank) bank.removeChild(blank);
      }

      let discard = create(tile);
      discard.mark(`discard`);
      discard.setFrom(player.id);
      this.discards.appendChild(discard);

      if (!config.BOT_PLAY && player.id !== this.id) {
        this.startCountDown(config.CLAIM_INTERVAL);
      }

      this.sortTiles(bank);
    }

    /**
     * See one or more tiles being revealed by a player.
     */
    see(tiles, player) {
      console.debug(`${this.id} sees ${tiles.map(t => t.dataset ? t.getTileFace() : t)} from ${player.id}`);

      let bank = this.playerbanks[player.id];

      // create a new locked set
      let locknum = 1 + bank.querySelectorAll(`[locked]`).length;
      tiles.forEach(tile => {
        let face = (tile.dataset ? tile.getTileFace() : tile);

        if (player.id != this.id) {
          // remove a `blank` tile to replace with the one we`re seeing.
          let blank = bank.querySelector(`[tile='-1']`);
          if (blank) bank.removeChild(blank);
        }

        let e = create(face);
        if (tile.isHidden && tile.isHidden()) e.hide();
        e.lock(locknum);
        bank.appendChild(e);
      });

      this.sortTiles(bank);
    }

    /**
     * see a reveal by a player specifically as a result
     * of claiminig a tile.
     *
     * This function falls through to `see()`
     */
    seeClaim(tiles, player, claim) {
      playClip(tiles.length===4 ? `kong` : `multi`);

      // this differs from see() in that we know we need to remove one
      // `blank` tile fewer than are being revealed. So we add one, and
      // then call see() to offset the otherwise superfluous removal.
      let bank = this.playerbanks[player.id];
      let blank = create(-1);
      bank.appendChild(blank);
      this.removeLastDiscard();
      this.see(tiles, player);

      // add a visual signal
      if (!config.BOT_PLAY) {
        this.renderClaimAnnouncement(player.id, claim.claimtype);
      }
    }

    /**
     * Take note of a player having to give up a kong
     * because someone just robbed it to win.
     */
    playerGaveUpKongTile(pid, tilenumber) {
      let bank = this.playerbanks[pid];
      let tile = bank.querySelector(`game-tile[locked][tile='${tilenumber}']`);
      tile.remove();
    }

    /**
     * Render a UI element that notified the user that some
     * other player claimed the discard for some purpose.
     */
    renderClaimAnnouncement(pid, claimtype) {
      let label = `win`;
      if (claimtype === 16) label = `kong`;
      if (claimtype === 8) label = `pung`;
      if (claimtype < 8) label = `chow`;
      let ann = document.createElement(`div`);
      ann.classList.add(`announcement`);
      ann.textContent = `${label}!`;
      ann.dataset.player = pid;
      let parent = document.querySelector(`.board`);
      parent.appendChild(ann);
      // transitionend seems to do all of nothing.
      setTimeout(() => ann.parentNode.removeChild(ann), 2300);
    }

    /**
     * Mark the fact that a player received `a tile`,
     * but we don`t know specifically which tile.
     */
    receivedTile(player) {
      if (player.id === this.id) return;
      let bank = this.playerbanks[player.id];
      bank.append(create(-1));
      this.sortTiles(bank);
    }

    /**
     * Sort all the tiles in a player`s tile bank
     * (either the user, or one of the bot players).
     */
    sortTiles(bank) {
      bank = (bank||this.el);
      Array
      .from(bank.querySelectorAll(`game-tile`))
      .sort(this.tilebank_sort_function)
      .forEach(tile => bank.appendChild(tile));
    }

    /**
     * Get all `locked=locked` tiles in a player`s tile bank.
     */
    getLockedTiles(bank) {
      return (bank||this.el).querySelectorAll(`game-tile[locked]`);
    }

    /**
     * Get all tiles in a player`s tile bank that are not locked, and not bonus tiles
     */
    getAvailableTiles() {
      return this.el.querySelectorAll(`game-tile:not([bonus]):not([locked])`);
    }

    /**
     * Find a single instance of a tile with the specified tile number,
     * or undefined if no such tile exists in the player`s hand.
     */
    getSingleTileFromHand(tileNumber) {
      return this.el.querySelector(`game-tile[tile='${tileNumber}']:not([locked])`);
    }

    /**
     * Get every instance of a specific tile in the player`s hand.
     */
    getAllTilesInHand(tileNumber) {
      return this.el.querySelectorAll(`game-tile[tile='${tileNumber}']:not([locked])`);
    }

    /**
     * Get either all tiles, or all `not locked` tiles.
     */
    getTiles(allTiles) {
      return this.el.querySelectorAll(`game-tile${allTiles ? ``: `:not([locked])`}`);
    }

    /**
     * Get the list of tiles as tile numbers, or all `not locked` tiles as tile numbers.
     */
    getTileFaces(allTiles) {
      return Array.from(this.getTiles(allTiles)).map(t => t.getTileFace());
    }

    /**
     * Sort tiles ordered as:
     * 1: bonus tiles
     * 2: locked tiles, sorted
     * 3: unlocked tiles, sorted
     * 4: concealed tiles
     */
    tilebank_sort_function(a,b) {
      try {
        let la = a.getLockNumber();
        let lb = b.getLockNumber();

        a = a.getTileFace();
        b = b.getTileFace();

        // 1: bonus tiles always go on the far left
        if (a>33 || b>33) {
          if (a>33 && b>33) return a-b;
          if (a>33) return -1;
          return 1;
        }

        // 2: locked tiles
        if (la || lb) {
          if (la && lb) return (la===lb) ? a - b : la - lb;
          if (la) return -1;
          return 1;
        }

        // 4 (out of order): for concealed tiles to the right
        if (a===-1) return 1;
        if (b===-1) return -1;

        // 3: plain compare for regular tiles
        return a - b;
      }
      catch (e) {
        console.log(a, b);
        console.log(a.constructor.name, b.constructor.name);
        throw (e);
      }
    }
  }

  /**
   * This is a graphical interface that players can use
   * to visualise their game knowledge, and allow external
   * interaction (human overrides for bots, or just plain
   * human input for... well, humans)
   */
  class ClientUI extends ClientUIMaster {
    constructor(player, tracker) {
      super(player, tracker);
      this.listeners = [];
      this.longPressTimeout = false;
    }

    listen(target, event, handler) {
      this.listeners.push({ target, event, handler });
      let opts = {};
      if (event.indexOf('touch') !== -1) opts.passive = true;
      target.addEventListener(event, handler, opts);
    }

    removeListeners(target, event) {
      let removals = this.listeners.filter(data => (data.target === target && data.event===event));
      removals.forEach(data => {
        let opts = {};
        if (data.event.indexOf('touch') !== -1) opts.passive = true;
        data.target.removeEventListener(data.event, data.handler, opts);
      });
      this.listeners = this.listeners.filter(data => (data.target !== target || data.event !== event));
      // return a "restore()" function that turns listening back on.
      return () => removals.forEach(data => this.listen(data.target, data.event, data.handler));
    }

    removeAllListeners() {
      let removals = this.listeners;
      removals.forEach(data => {
        let opts = {};
        if (data.event.indexOf('touch') !== -1) opts.passive = true;
        data.target.removeEventListener(data.event, data.handler, opts);
      });
      this.listeners = [];
      return () => removals.forEach(data => this.listen(data.target, data.event, data.handler));
    }

    pause(lock) {
      super.pause(lock);
      if(this.claimTimer) this.claimTimer.pause();
    }

    resume() {
      super.resume();
      if(this.claimTimer) this.claimTimer.resume();
    }

    /**
     * Called by `determineDiscard` in human.js, this function
     * lets the user pick a tile to discard through the GUI.
     */
    listenForDiscard(resolve, suggestions, lastClaim, winbypass) {
      // Figure out the initial tile to highlight
      let tiles = this.getAvailableTiles();
      let currentTile = this.currentTile = this.player.latest;
      let curid = currentTile ? Array.from(tiles).indexOf(currentTile) : 0;
      if (curid === -1) curid = 0;
      this.markCurrentTile(curid);

      // highlight the discard suggestion
      this.highlightBotSuggestions(suggestions);

      // If we have no tiles left to discard, that's
      // an automatic win declaration.
      if (tiles.length === 0) return resolve(undefined);

      // If we just claimed a win, that's also
      // an automatic win declaration.
      if (lastClaim && lastClaim.claimtype === CLAIM$1.WIN) return resolve(undefined);

      // If the bot knows we have a winning hand,
      // let the user decide whether to declare a
      // win or whether to keep playing.
      let { winner } = this.player.tilesNeeded();
      if (winner && !winbypass) return this.askForWinConfirmation(resolve);

      // tag all tiles to allow for CSS highlighting
      tiles.forEach(tile => tile.mark('selectable'));

      // Add keyboard and mouse event listening for navigating
      // the selectable tiles and picking a discard.
      this.listen(document, "keydown", evt => this.listenForDiscardFromKeys(evt, tiles, suggestions, resolve));
      this.listenForDiscardFromMouse(tiles, suggestions, resolve);
    }

    /**
     * Mouse/touch interaction for discard selection.
     */
    listenForDiscardFromMouse(tiles, suggestions, resolve) {
      tiles.forEach(tile => this.addMouseEventsToTile(tile, suggestions, resolve));
    }

    /**
     * Add both mouse and touch event handling to all
     * (discardable) tiles in the player's tilebank.
     */
    addMouseEventsToTile(tile, suggestions, resolve) {
      //console.log(tile, suggestions);
      this.listen(tile, "mouseover", evt => this.highlightTile(tile));
      this.listen(tile, "click", evt => this.discardCurrentHighlightedTile(suggestions, resolve));
      this.listen(tile, "mousedown", evt => this.initiateLongPress(evt, suggestions, resolve));
      this.listen(tile, "touchstart", evt => this.initiateLongPress(evt, suggestions, resolve));
    }

    /**
     * Keyboard interaction for discard selection.
     */
    listenForDiscardFromKeys(evt, tiles, suggestions, resolve) {
      let code = evt.keyCode;
      let willBeHandled = [VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN, VK_SIGNAL, VK_START, VK_END].some(supported => supported[code]);
      if (!willBeHandled) return;
      if (VK_SIGNAL[code] && evt.repeat) return; // ignore all "action" key repeats

      evt.preventDefault();

      // Handling for moving the highlight from one tile to another.
      let tlen = tiles.length;
      let currentTile = this.currentTile;
      let curid = this.curid;
      if (VK_LEFT[code]) curid = (currentTile === false) ? tlen - 1 : (curid === 0) ? tlen - 1 : curid - 1;
      if (VK_RIGHT[code]) curid = (currentTile === false) ? 0 : (curid === tlen-1) ? 0 : curid + 1;
      if (VK_START[code]) curid = 0;
      if (VK_END[code]) curid = tlen-1;
      currentTile = this.markCurrentTile(curid);

      // "up"/"signal" is the discard action.
      if (VK_UP[code] || VK_SIGNAL[code]) {
        if (!vk_signal_lock) {
          lock_vk_signal();
          this.currentTile.unmark('highlight');
          this.discardCurrentHighlightedTile(suggestions, resolve);
        }
      }

      // "down" is used to declared self-drawn kongs and self-drawn wins.
      if (VK_DOWN[code]) this.spawnDeclarationModal(suggestions, resolve);
    }

    /**
     * Highlight a particular tile
     */
    highlightTile(tile) {
      let tiles = this.getAvailableTiles();
      let curid = Array.from(tiles).indexOf(tile);
      this.markCurrentTile(curid);
    }

    /**
     * Highlight a particular tile
     */
    markCurrentTile(curid) {
      let tiles = this.getAvailableTiles();
      if (tiles.length === 0) return;
      this.curid = curid;
      this.currentTile = tiles[curid];
      tiles.forEach(tile => tile.unmark('highlight'));
      this.currentTile.mark('highlight');
      return this.currentTile;
    };


    /**
     * Initiate a longpress timeout. This will get cancelled by
     * the discard action, as well as by touch-up events.
     */
    initiateLongPress(evt, suggestions, resolve) {
      let releaseEvents = ['mouseup', 'dragend', 'touchend'];
      if (evt.type === 'mousedown' && evt.which !== 1) return;
      if (!this.longPressTimeout) {
        this.longPressTimeout = setTimeout(() => {
          //console.log('removing document mouseup/touchend');
          releaseEvents.forEach(event => this.removeListeners(document, event));
          this.cancelLongPress();
          let restoreClickHandling = this.removeListeners(evt.target, "click");
          this.spawnDeclarationModal(suggestions, resolve, restoreClickHandling);
        }, 1000);
      }
      let cancelPress = evt => this.cancelLongPress(evt);
      releaseEvents.forEach(event => this.listen(document, event, cancelPress));
    };

    /**
     * cancel a long-press timeout
     */
    cancelLongPress(evt) {
      if (this.longPressTimeout) {
        this.longPressTimeout = clearTimeout(this.longPressTimeout);
      }
    }

    /**
     * Highlight the tile that the superclass would discard if they were playing.
     */
    highlightBotSuggestions(suggestions) {
      if (config.SHOW_BOT_SUGGESTION && suggestions) {
        suggestions.forEach(suggestion => {
          if (!suggestion) return;
          let suggestedTile = this.getSingleTileFromHand(suggestion.getTileFace());
          if (suggestedTile) {
            suggestedTile.mark('suggestion');
            suggestedTile.setTitle('Bot-recommended discard.');
          } else {
            console.log(`The bot got confused and wanted you to throw out something that's not in your hand...!`);
            console.log(suggestion);
          }      });
      }
    }

    /**
     * The user can win with the tiles they currently have. Do they want to?
     */
    askForWinConfirmation(resolve) {
      // console.log('scent of claim?', this.id, ':', this.player.lastClaim);

      let cancel = () => resolve(undefined);
      modal.choiceInput("Declare win?", [
        { label: 'You better believe it!', value: 'win' },
        { label: 'No, I think I can do better...', value: '' },
      ], result => {
        if (result) {
          if (!this.player.lastClaim) {
            this.player.selfdraw = true;
          }
          resolve(undefined);
        }
        else this.listenForDiscard(resolve, undefined, undefined, true); // suggestions, lastClaim, winbypass
      }, cancel);
    }

    /**
     * Discard a selected tile from the player's hand
     */
    discardCurrentHighlightedTile(suggestions=[], resolve) {
      let tiles = this.getAvailableTiles();
      this.cancelLongPress();
      suggestions.forEach(suggestion => {
        if (suggestion) {
          suggestion.unmark('suggestion');
          suggestion.setTitle('');
        }
      });
      let latest = this.player.latestTile;
      if (latest) latest.unmark('latest');
      tiles.forEach(tile => tile.unmark('selectable','highlight','suggestion'));
      this.removeAllListeners();
      resolve(this.currentTile);
    }

    /**
     * Called in several places in `listenForDiscard`, this function
     * spawns a modal that allows the user to declaring they can
     * form a kong or that they have won on their own turn.
     */
    spawnDeclarationModal(suggestions, resolve, restore) {
      let currentTile = this.currentTile;
      let face = currentTile.getTileFace();
      let allInHand = this.getAllTilesInHand(face);
      let canKong = false;

      // do we have a concealed kong?
      if (allInHand.length === 4) canKong = true;

      // can we meld a kong?
      else if (this.player.locked.some(set => set.every(t => t.getTileFace()==face))) canKong = true;

      // can we declare a standard win?
      let { winpaths } = this.player.tilesNeeded();
      let canWin = winpaths.length > 0;

      // can we declare a limit hand?
      if (!canWin) {
        let allTiles = this.getTileFaces(true).filter(t => t<34);
        canWin = this.player.rules.checkForLimit(allTiles);
      }

      // build the self-declare options for this action
      let options = [
        { label: "on second thought, never mind", value: CLAIM$1.IGNORE },
        canKong ? { label: "I'm declaring a kong", value: CLAIM$1.KONG } : false,
        canWin ? { label: "I just won", value: CLAIM$1.WIN } : false
      ].filter(v=>v);

      modal.choiceInput("Declare a kong or win?", options, result => {
        if (result === CLAIM$1.IGNORE) {
          if (restore) return restore();
        }
        if (result === CLAIM$1.KONG) {
          currentTile.exception = CLAIM$1.KONG;
          currentTile.kong = [...allInHand];        return this.discardCurrentHighlightedTile(suggestions, resolve);
        }
        if (result === CLAIM$1.WIN) {
          this.currentTile = undefined;
          return this.discardCurrentHighlightedTile(suggestions, resolve);
        }
      });
    }

    /**
     * Called by `determineClaim` in human.js, this function
     * lets the user decide whether or not to claim the discard
     * in order to form a specific set, or even win.
     */
    listenForClaim(pid, discard, suggestion, resolve, interrupt, claimTimer) {
      let tile = this.discards.lastChild;
      let mayChow = this.player.mayChow(pid);

      // make sure that all events we set up get removed when the timer ticks over.
      this.claimTimer = claimTimer;
      this.setClaimTimerCleanup(() => this.removeAllListeners());

      // show general claim suggestions
      if (config.SHOW_CLAIM_SUGGESTION) {
        this.tryClaimHighlight(pid, tile, mayChow);
      }

      // show the bot's play suggestions
      if (config.SHOW_BOT_SUGGESTION && suggestion) {
        if (suggestion && suggestion.claimtype) {
          tile.mark('suggestion');
        }
      }

      // an unpause protection, so that a mousedown/touchstart that
      // resumes a paused state does not then also allow the click
      // from the same event interaction to go through
      this.pause_protection = false;

      // Start listening for discard claim events
      this.setupInputListening(tile, mayChow, interrupt, resolve);
    }

    /**
     * Set up all the event listening necessary to enable
     * keyboard and mouse triggers for claims.
     */
    setupInputListening(tile, mayChow, interrupt, resolve) {
      tile.mark('selectable');
      let discards = this.discards;
      this.listen(tile, "click",  evt => this.triggerClaimDialog(tile, mayChow, interrupt, resolve));
      this.listen(discards, "click", evt => this.safelyIgnoreDicard(evt, tile, mayChow, interrupt, resolve));
      this.listen(discards, "mousedown", evt => this.verifyPauseProtection());
      this.listen(discards, "touchstart", evt => this.verifyPauseProtection());
      this.listen(document, "keydown", evt => this.handleKeyDuringClaim(evt, tile, mayChow, interrupt, resolve));
    }

    /**
     * Set the pause protection flag based on
     * the current pause state.
     */
    verifyPauseProtection() {
      if (this.paused) {
        this.pause_protection = true;
      }
    };

    /**
     * Get the distance from a click event to the
     * center of the specified tile.
     */
    getDistanceToTile(evt, tile) {
      let bbox = tile.getBoundingClientRect();
      let midpoint = { x: (bbox.left + bbox.right)/2, y: (bbox.top + bbox.bottom)/2 };
      let vector = { x: midpoint.x - evt.clientX, y: midpoint.y - evt.clientY };
      return Math.sqrt(vector.x ** 2 + vector.y ** 2);
    }

    /**
     * Register that user interaction has occurred.
     */
    registerUIInput(interrupt) {
      if (this.countdownTimer) this.countdownTimer.cancel();
      interrupt();
    }

    /**
     * Handle key events during listenForClaim.
     */
    handleKeyDuringClaim(evt, tile, mayChow, interrupt, resolve) {
      // Prevent keyrepeat immediately kicking in off of a discard action, which uses the same signal:
      if (vk_signal_lock) return;

      let code = evt.keyCode;
      let willBeHandled = (VK_LEFT[code] || VK_RIGHT[code] || VK_UP[code] || VK_SIGNAL[code]);
      if (!willBeHandled) return;
      evt.preventDefault();
      this.removeAllListeners();
      if (VK_UP[code] || VK_SIGNAL[code]) return this.triggerClaimDialog(tile, mayChow, interrupt, resolve);
      return this.ignoreDiscard(tile, interrupt, resolve);
    }

    /**
     * Let the game know we're not interested in
     * claiming the current discard for anything.
     */
    ignoreDiscard(tile, interrupt, resolve) {
      this.registerUIInput(interrupt);
      tile.unmark('highlight');
      tile.unmark('suggestion');
      tile.unmark('selectable');
      this.removeAllListeners();
      resolve({ claimtype: CLAIM$1.IGNORE });
    }

    /**
     * This adds a safety region around the discarded tile, for
     * fat fingers, as well as unpause protection (not registering
     * as real "click" if we just resumed from a paused state).
     */
    safelyIgnoreDicard(evt, tile, mayChow, interrupt, resolve) {
      if (this.pause_protection) {
        return (this.pause_protection = false);
      }
      if (this.getDistanceToTile(evt, tile) > 40) {
        return this.ignoreDiscard(tile, interrupt, resolve);
      }
      this.triggerClaimDialog(tile, mayChow, interrupt, resolve);
    }

    /**
     * Can we highlight the latest discard as a signal
     * to the user that it's (technically, but not
     * necessarily practically) a claimable tile.
     */
    tryClaimHighlight(pid, tile, mayChow) {
      let face = tile.getTileFace();
      let suit = ((face/9)|0);
      let { lookout } = this.player.tilesNeeded();
      let types = lookout[face];

      if (types) {
        for(let type of types) {
          if (CLAIM$1.CHOW <= type && type < CLAIM$1.PUNG && !mayChow) continue
          return tile.mark('highlight');
        }
      }

      this.tryChowHighlight(tile, mayChow, face, suit);
    }

    /**
     * If we already have a chow with this tile in it, then
     * we might not actually _need_ this tile, and so lookout
     * won't list it. Even though it's a legal claim.
     */
    tryChowHighlight(tile, mayChow, face, suit) {
      if (mayChow && face < 27 && this.getSingleTileFromHand(face)) {
        let
        n1 = face < 26 && this.getSingleTileFromHand(face+1), sn1 = (((face+1)/9)|0),
        n2 = face < 25 && this.getSingleTileFromHand(face+2), sn2 = (((face+2)/9)|0),
        p2 = face > 1 && this.getSingleTileFromHand(face-2), sp2 = (((face-2)/9)|0),
        p1 = face > 0 && this.getSingleTileFromHand(face-1), sp1 = (((face-1)/9)|0),
        c1 = n2 && n1 && sn2===suit && sn1===suit,
        c2 = n1 && p1 && sn1===suit && sp1===suit,
        c3 = p2 && p1 && sp2===suit && sp1===suit;
        if (c1 || c2 || c3) tile.mark("highlight");
      }
    }

    /**
     * Set up the dialog spawning for when the user elects to stake a claim.
     */
    triggerClaimDialog(tile, mayChow, interrupt, resolve) {
      this.registerUIInput(interrupt);
      this.removeAllListeners();

      let cancel = () => this.ignoreDiscard(tile, interrupt, resolve);

      let { lookout } = this.player.tilesNeeded();
      let claimList = lookout[tile.getTileFace()];
      let mayWin = claimList && claimList.some(type => parseInt(type) === CLAIM$1.WIN);

      console.debug(this.player.id, tile, mayChow, this, this.canPung(tile));

      modal.choiceInput("What kind of claim are you making?", [
        { label: "Ignore", value: CLAIM$1.IGNORE },
        (mayChow && this.canChow(tile, CLAIM$1.CHOW1)) ? { label: "Chow (▮▯▯)", value: CLAIM$1.CHOW1 } : false,
        (mayChow && this.canChow(tile, CLAIM$1.CHOW2)) ? { label: "Chow (▯▮▯)", value: CLAIM$1.CHOW2 } : false,
        (mayChow && this.canChow(tile, CLAIM$1.CHOW3)) ? { label: "Chow (▯▯▮)", value: CLAIM$1.CHOW3 } : false,
        this.canPung(tile) ? { label: "Pung", value: CLAIM$1.PUNG } : false,
        this.canKong(tile) ? { label: "Kong", value: CLAIM$1.KONG } : false,
        mayWin ? { label: "Win", value: CLAIM$1.WIN } : false,
      ], result => {
        tile.unmark('highlight');
        tile.unmark('suggestion');
        tile.unmark('selectable');
        this.removeAllListeners();
        if (result === CLAIM$1.WIN) return this.spawnWinDialog(tile, claimList, resolve, cancel);
        resolve({ claimtype: result });
      }, cancel);
    }

    /**
     * Do we want to rob a kong to win?
     */
    spawnKongRobDialog(pid, tiles, tilesRemaining, suggestions, resolve) {
      let tile = tiles[0].getTileFace();
      let claim = false;

      if (suggestions && suggestions[0]) claim = suggestions[0];
      else {
        (() => {
          let { lookout, waiting } = this.player.tilesNeeded();
          if (!waiting) return;
          let need = lookout[tile];
          if (!need) return;
          let reasons = need.filter(v => v.indexOf('32')!==0);
          if (reasons.length === 0) return;
          claim = {
            from: pid,
            tile: tile,
            claimtype: CLAIM$1.WIN,
            wintype: (reasons[0]|0),
          };
        })();
      }

      if (!claim) return resolve();

      modal.choiceInput("Win by robbing a kong?", [
        { label: 'You better believe it!', value: 'win' },
        { label: 'No, I think I can do better...', value: '' },
      ], result => {
        if (result) return resolve(claim);
        resolve();
      }, () => resolve());
    }

    /**
     * Called in `listenForClaim`, this function spawns a modal
     * that allows tlistenForClhe user to claim a discard for the purposes
     * of declaring a win.
     */
    spawnWinDialog(discard, claimList, resolve, cancel) {
      // determine how this player could actually win on this tile.
      let winOptions = { pair: false, chow: false, pung: false };

      claimList.forEach(type => {
        if (parseInt(type) === CLAIM$1.WIN) {
          let subtype = parseInt(type.split('s')[1]);
          if (subtype === CLAIM$1.PAIR) winOptions.pair = true;
          if (subtype >= CLAIM$1.CHOW && subtype < CLAIM$1.PUNG) winOptions.chow = true;
          if (subtype >= CLAIM$1.PUNG) winOptions.pung = true;
        }
      });

      let options = [
        winOptions.pair ? { label: "Pair", value: CLAIM$1.PAIR } : false,
        winOptions.chow && this.canChow(discard, CLAIM$1.CHOW1) ? { label: "Chow (▮▯▯)", value: CLAIM$1.CHOW1 } : false,
        winOptions.chow && this.canChow(discard, CLAIM$1.CHOW2) ? { label: "Chow (▯▮▯)", value: CLAIM$1.CHOW2 } : false,
        winOptions.chow && this.canChow(discard, CLAIM$1.CHOW3) ? { label: "Chow (▯▯▮)", value: CLAIM$1.CHOW3 } : false,
        winOptions.pung ? { label: "Pung", value: CLAIM$1.PUNG } : false
      ];

      modal.choiceInput("How does this tile make you win?", options, result => {
        resolve({ claimtype: CLAIM$1.WIN, wintype: result });
      }, cancel);
    }
  }

  /**
   * And this is a human player... which is "a kind
   * of bot player" and that might seem surprising,
   * but the reason we do this is because it allows
   * us to get a bot player helping the human player
   * "for free", and that's great!
   */
  class HumanPlayer extends BotPlayer {
    constructor(id, chicken=false) {
      super(id, chicken);
      // humans need a UI to play mahjong.
      this.ui = new ClientUI(this, this.tracker);
    }

    /**
     * Let the human player figure out what to discard
     * through the UI. However, have the underlying bot
     * perform their discard logic and offer the tile
     * they come with as a play suggestion.
     */
    determineDiscard(tilesRemaining, resolve) {
      const giveAllSuggestions = true;
      // Let's ask our "bot" assistant for what
      // it would suggest we throw away:
      super.determineDiscard(tilesRemaining, suggestion => {
        if (config.BOT_PLAY) return resolve((suggestion && suggestion.length) ? suggestion[0] : suggestion);
        if (suggestion && !suggestion.length) suggestion = [suggestion];
        this.ui.listenForDiscard(discard => {

          // If we're discarding, even if our bot superclass
          // determined we were holding a selfdrawn win, we
          // are not claiming a win and so need to unset this:
          if (discard) this.selfdraw = false;

          // Special handling for self-declared kongs:
          if (discard && discard.exception === CLAIM$1.KONG) {
            let kong = discard.kong;

            // fully concealed kong!
            if (kong.length === 4) this.lockClaim(kong, true);

            // melded kong from existing pung:
            else this.meldKong(kong[0]);
          }

          // And then fall through to the original resolution function
          resolve(discard);
        }, suggestion, this.lastClaim);
      }, giveAllSuggestions);
    }

    /**
     * Let the human player figure out whether to make
     * a claim through the UI. However, have the underlying
     * bot perform their claim logic and offer the claim
     * they come with as a play suggestion.
     */
    determineClaim(pid, discard, tilesRemaining, resolve, interrupt, claimTimer) {
      // And of course, the same applies here:
      super.determineClaim(pid, discard, tilesRemaining, suggestion => {
        if (config.BOT_PLAY) return resolve(suggestion);
        this.ui.listenForClaim(pid, discard, suggestion, resolve, interrupt, claimTimer);
      });
    }

    /**
     * Let the human player figure out whether to rob a
     * kong, if it means they can win. However, have the
     * underlyaing bot perform their analysis and offer
     * their conclusion as a play suggestion.
     */
    robKong(pid, tiles, tilesRemaining, resolve) {
      super.robKong(pid, tiles, tilesRemaining, suggestion => {
        if (config.BOT_PLAY) return resolve(suggestion);
        this.ui.spawnKongRobDialog(pid, tiles, tilesRemaining, suggestion, resolve);
      });
    }
  }

  let base = [...new Array(34)].map((_, i) => i);
  const BASE = base
    .concat(base)
    .concat(base)
    .concat(base)
    .concat([34, 35, 36, 37, 38, 39, 40, 41]);

  /**
   * This basically represents a shuffled a pile of tiles
   * for dealing from during a hand of play.
   */
  class Wall {
    constructor(players) {
      this.players = players;
      this.reset();
    }

    // shuffle utility function, also used by WallHack
    getBase() {
      return BASE.slice();
    }

    // shuffle utility function, also used by WallHack
    shuffle(list) {
      list = list.slice();
      let shuffled = [];
      while (list.length) {
        let pos = (config.PRNG.nextFloat() * list.length) | 0;
        shuffled.push(list.splice(pos, 1)[0]);
      }
      return shuffled;
    }

    /**
     * Reset the wall to a full set of tiles, then shuffle them.
     */
    reset() {
      this.tiles = this.shuffle(this.getBase());
      this.deadSize = 16;
      this.dead = false;
      this.remaining = this.tiles.length - this.dead;

      // if there's a wall hack active, throw away what
      // we just did and use the hacked wall instead.
      if (config.WALL_HACK) {
        WallHack.set(this, WallHack.hacks[config.WALL_HACK]);
      }
    }

    /**
     * Get one or more tiles from this pile of tiles.
     */
    get(howMany = 1) {
      let left = this.tiles.length - howMany;
      this.remaining = left - this.deadSize;
      this.players.forEach((p) => p.markTilesLeft(this.remaining));
      this.dead = this.tiles.length - howMany <= this.deadSize;
      if (howMany === 1) return this.tiles.shift();
      return this.tiles.splice(0, howMany);
    }
  }

  /**
   * This class models an entire game.
   */
  class Game {
    constructor(players) {
      this.players = players;
      this.wall = new Wall(players);
      this.scoreHistory = [];
      this._playLock = false;
      this.GAME_START = false;

      // This gets redeclared by pause(), but we allocate
      // it here so that it exists as callable noop.
      this.resume = () => {};
    }

    /**
     * Start a game of mahjong!
     */
    async startGame(whenDone) {
      document.body.classList.remove(`finished`);
      this.GAME_START = Date.now();
      this.currentpid = 0;
      this.wind = 0;
      this.windOfTheRound = 0;
      this.hand = 0;
      this.draws = 0;
      this.totalDraws = 0;
      this.totalPlays = 0;
      this.finish = whenDone;
      this.rules = Ruleset.getRuleset(config.RULES);

      let players = this.players;

      await players.asyncAll(p => p.gameWillStart(this, this.rules));

      this.fixValues = () => {
        // drop in term fixes (hand/draw/seed/wind/wotr) here.
      };

      config.log(`starting game.`);
      this.startHand();
    }

    /**
     * Pause this game. Which is harder than it sounds,
     * really what this function does is it sets a
     * local lock that we can check at every point
     * in the code where we can reasonably pause.
     *
     * Being paused is then effected by waiting for
     * the lock to be released again.
     *
     * Note that the corresponding `.resume()` is
     * not part of the class definition, and is built
     * only as needed by when `pause()` is invoked.
     */
    async pause() {
      if (!this.GAME_START) return;
      console.debug('pausing game');

      let players = this.players;

      this._playLock = new Promise(resolve => {
        this.resume = async () => {
          console.debug('resuming game');
          this._playLock = false;
          await players.asyncAll(p => p.resume());
          resolve();
        };
      });

      await players.asyncAll(p => p.pause(this._playLock));

      return this.resume;
    }

    /**
     * A utility function that works together with
     * the pause lock to ensure that when we're paused,
     * execution is suspended until the lock is released.
     */
    async continue(where='unknown') {
      if (this._playLock) {
        console.debug(`paused at ${where}`);
        await this._playLock;
      }
    }

    /**
     * Triggered immediately after `startGame`, as well as
     * at the end of every `play()` cycle, this function
     * keeps getting called for as long as there are hands
     * left to play in this particular game.
     */
    async startHand(result = {}) {
      await this.continue();

      let players = this.players;

      if (result.winner) {
        // rotate the winds, unless the winner is East and the ruleset says not to in that case.
        let winner = result.winner;
        if (this.rules.pass_on_east_win || winner.wind !== 0) {
          let windWas = this.wind;
          this.wind = (this.wind + (this.rules.reverse_wind_direction ? 3 : 1)) % 4;

          if (windWas === (this.rules.reverse_wind_direction ? 1 : 3)) {
            this.wind = 0;
            this.windOfTheRound++;
            if (this.windOfTheRound === 4) {
              let ms = (Date.now() - this.GAME_START);
              let s = ((ms/10)|0)/100;
              let finalScores = players.map(p => p.getScore());
              let highest = finalScores.reduce((t,v) => v>t?v:t, 0);
              let gamewinner = finalScores.indexOf(highest);
              console.log(`\nfull game played: player ${gamewinner} is the winner!`);
              console.log(`(game took ${s}s. ${this.totalPlays} plays: ${this.hand} hands, ${this.totalDraws} draws)`);

              await players.asyncAll(p => p.endOfGame(finalScores));

              return this.finish(s);
            }
          }
        } else console.debug(`Winner player was East, winds will not rotate.`);
      }

      this.totalPlays++;
      if (!result.draw && !config.FORCE_DRAW) {
        this.hand++;
        this.draws = 0;
      } else {
        config.log(`Hand was a draw.`);
        this.draws++;
        this.totalDraws++;
      }

      await players.asyncAll(p => {
        let offset = parseInt(p.id);
        let playerwind = (this.wind + offset) % 4;

        // Do we need to rotate player winds in the
        // opposite direction of the round winds?
        if (this.rules.reverse_wind_direction) {
          playerwind = (4 + this.wind - offset) % 4;
        }

        p.reset(playerwind, this.windOfTheRound, this.hand, this.draws);
      });

      // used for play debugging:
      if (config.PAUSE_ON_HAND && this.hand === config.PAUSE_ON_HAND) {
        config.HAND_INTERVAL = 60 * 60 * 1000;
      }

      // "Starting hand" / "Restarting hand"
      let pre = result.draw ? 'Res' : 'S';
      let logNotice = `${pre}tarting hand ${this.hand}.`;
      let style = `color: red; font-weight: bold; font-size: 120%; border-bottom: 1px solid black;`;
      //console.log(`\n${ (typeof process === "undefined") ? `%c` : `` }${logNotice}`, (typeof process === "undefined") ? style : ``);
      config.log(`\n${logNotice}`);

      if (this.fixValues) { this.fixValues(); this.fixValues=()=>{}; }

      logNotice = `this.hand=${this.hand}; this.draws=${this.draws}; config.PRNG.seed(${config.PRNG.seed()}); this.wind=${this.wind}; this.windOfTheRound=${this.windOfTheRound};`;
      //console.log(logNotice);
      config.log(logNotice);

      this.wall.reset();
      logNotice = `wall: ${this.wall.tiles}`;
      console.debug(logNotice);
      config.log(logNotice);

      config.log(`initial deal`);

      await this.dealTiles();

      players.forEach(p => {
        let message = `tiles for ${p.id}: ${p.getTileFaces()}`;
        console.debug(message);
        config.log(message);
      });

      config.log(`prepare play`);

      await this.preparePlay(config.FORCE_DRAW || this.draws > 0);

      players.forEach(p => {
        let message = `tiles for ${p.id}: ${p.getTileFaces()} [${p.getLockedTileFaces()}]`;
        console.debug(message);
        config.log(message);
      });

      await players.asyncAll(p => p.playWillStart());

      this.PLAY_START = Date.now();
      this.play();
    }

    /**
     * Called as part of `startHand`, this function deals
     * 13 play tiles to each player, making sure that any
     * bonus tiles are compensated for.
     */
    async dealTiles() {
      await this.continue("dealTiles");

      let wall = this.wall;
      let players = this.players;

      // The internal function for actually
      // giving initial tiles to players.
      let runDeal = async (player, done) => {
        let bank = wall.get(13);
        for (let t=0, tile; t<bank.length; t++) {
          tile = bank[t];

          await players.asyncAll(p => p.receivedTile(player));

          let revealed = player.append(tile);
          if (revealed) {
            // bonus tile are shown to all other players.
            await players.asyncAll(p => p.see(revealed, player));
            bank.push(wall.get());
          }
        }
        done();
      };

      // make sure the game can wait for all deals to finish:
      return Promise.all(players.map(p => {
        return new Promise(done => runDeal(p, done));
      }));
    }

    /**
     * Called as part of `startHand`, right after `dealTiles`,
     * this function preps all players for the start of actual
     * game play.
     */
    async preparePlay(redraw) {
      await this.continue("preparePlay");

      this.currentPlayerId = (this.wind % 4);
      this.discard = undefined;
      this.counter = 0;

      let players = this.players;

      // wait for "ready" from each player in response to a "hand will start" notice
      await Promise.all(players.map(p => {
        return new Promise(ready => p.handWillStart(redraw, ready))
      }));

      if (!noSleepEnabled) {
        var noSleep = new NoSleep();
        noSleep.enable();
        noSleepEnabled = true;
      }

      // at this point, the game can be said to have started, but
      // we want to make sure that any player that, at the start
      // of actual play, has a kong in their hand, is given the
      // option to declare that kong before tiles start getting
      // discarded:

      await Promise.all(players.map(p => {
        return new Promise(done => this.resolveKongs(p, done));
      }));
    }

    /**
     * Called as the last step in `preparePlay`, to give
     * players an opportunity to declare any hidden kongs
     * before the first player gets to "draw one, play one".
     */
    async resolveKongs(player, done) {
      await this.continue("resolveKongs");

      this.players;
      let kong;
      do {
        kong = await player.checkKong();
        if (kong) {
          await this.processKong(player, kong);
          // TODO: someone not-East COULD technically win at this point!
        }
      } while (kong);

      done();
    }

    /**
     * When a player declares a kong, show this to all other
     * players and issue them a compensation tile. Which
     * may, of course, be a bonus tile, so keep going until
     * the player no longer reveals their just-dealt tile.
     */
    async processKong(player, kong, melded=false) {
      console.debug(`${player.id} plays kong ${kong[0].getTileFace()} (melded: ${melded})`);
      config.log(`${player.id} locks [${kong.map(t => t.getTileFace())}]`);

      let players = this.players;
      let robbed = await Promise.all(
        players.map(p => new Promise(resolve => p.seeKong(kong, player, this.wall.remaining, resolve)))
      );

      for (let [pid, claim] of robbed.entries()) {
        if (claim) {
          claim.by = pid;
          return claim;
        }
      }

      // deal supplement tile(s) for as long as necessary
      let revealed = false;
      do {
        let tile = this.wall.get();
        config.log(`${player.id} <  ${tile} (supplement)`);
        revealed = player.append(tile);
        if (revealed) {
          await players.asyncAll(p => p.see(revealed, player));
        }
      } while (revealed);
    }

    /**
     * if a kong got robbed, then this hand is over and we should exit play()
     */
    async processKongRob(claim) {
      let pid = claim.from;
      let players = this.players;
      let tile = players[pid].giveUpKongTile(claim.tile);

      await players.asyncAll(p => p.playerGaveUpKongTile(pid, claim.tile));

      let winner = players[claim.by];
      winner.robbed = true;
      this.currentPlayerId = winner.id;
      let robbed = true;
      winner.receiveDiscardForClaim(claim, tile, robbed);
      return this.processWin(winner, pid);
    }

    /**
     * This is the last call in `startHand`, and is our main game
     * loop. This function coordinates players drawing a tile
     * (either from the wall, or as a claimed discard from a
     * previous player), rewarding claims on discards, and
     * determining whether the hand has been won or drawn based
     * on whether or not players are witholding their discard,
     * or the wall has run out of tiles to deal from.
     */
    async play(claim) {
      await this.continue("start of play()");

      // Bootstrap this step of play
      let hand = this.hand;
      let players = this.players;
      let wall = this.wall;
      if (claim) this.currentPlayerId = claim.p;
      let discard = this.discard;
      let discardpid = discard ? discard.getFrom() : undefined;
      let currentPlayerId = this.currentPlayerId;
      this.playDelay = (hand===config.PAUSE_ON_HAND && this.counter===config.PAUSE_ON_PLAY) ? 60*60*1000 : config.PLAY_INTERVAL;
      let player = players[currentPlayerId];

      await players.asyncAll(p => p.activate(currentPlayerId));

      // increase the play counter for debugging purposes:
      this.counter++;
      console.debug(`%chand ${hand}, play ${this.counter}`, `color: red; font-weight: bold;`);
      console.debug(`current seed: ${config.PRNG.seed()}`);

      // ===========================
      // GAME LOOP: "Draw one" phase
      // ===========================

      if (!claim) {
        // If this is a plain call, then the player receives
        // a tile from the shuffled pile of tiles:
        discard = false;
        discardpid = false;
        let claim = await this.dealTile(player);
        if (claim) return this.processKongRob(claim);
      }

      else {
        // If this is claim call, then the player receives
        // the current discard instead of drawing a tile:
        config.log(`${player.id} <  ${discard.getTileFace()} (${claim.claimtype})`);
        let tiles = player.receiveDiscardForClaim(claim, discard);
        config.log(`${player.id} has [${player.getTileFaces()}], [${player.getLockedTileFaces()}]`);

        await players.asyncAll(p => p.seeClaim(tiles, player, discard, claim));

        // If this was a kong, can someone rob it to win?
        if (tiles.length === 4) {
          let kong = tiles;
          let robbed = await Promise.all(
            players.map(p => new Promise(resolve => p.robKong(player.id, kong, this.wall.remaining, resolve)))
          );
          for (let [pid, claim] of robbed.entries()) {
            if (claim) {
              claim.by = pid;
              return this.processKongRob(claim);
            }
          }

          // if no one can, then this player now needs a supplement tile.
          await this.dealTile(player);
        }
      }


      // ===========================
      // GAME LOOP: "Play one" phase
      // ===========================

      do {
        if (discard) discard.unmark('discard');

        discard = this.discard = await new Promise(resolve => player.getDiscard(wall.remaining, resolve));

        // Did anyone win?
        if (!discard) return this.processWin(player, discardpid);

        // no winner, but did this player declare/meld a kong?
        if (discard.exception === CLAIM$1.KONG) {
          let kong = discard.kong;
          let melded = (kong.length === 1);

          // If they did, can someone rob it?
          let claim = await this.processKong(player, kong, melded);
          if (claim) return this.processKongRob(claim);

          // No one robbed this kong. Set the discard to `false` so
          // that we enter the "waiting for discard from player"
          // state again.
          discard = false;
        }
      } while (!discard);
      // note: we will have exited `play()` in the event of a
      // "no discard" win, which is why this check is safe.


      // No winner - process the discard.
      await this.processDiscard(player);

      // Does someone want to claim this discard?
      await this.continue("just before getAllClaims() in play()");
      claim = await this.getAllClaims(); // players take note of the fact that a discard happened as part of their determineClaim()
      if (claim) return this.processClaim(player, claim);

      // No claims: have we run out of tiles?
      if (wall.dead) {
        //console.log(`Hand ${hand} is a draw.`);

        await players.asyncAll(p => p.endOfHand());

        let nextHand = () => this.startHand({ draw: true });
        if (!config.BOT_PLAY) {
          return modal.choiceInput("Hand was a draw", [{label:"OK"}], nextHand, nextHand);
        } else return setTimeout(nextHand, this.playDelay);
      }

      // If we get here, nothing of note happened, and we just move on to the next player.
      await this.continue("just before scheduling the next play() call");

      await players.asyncAll(p => p.nextPlayer());

      this.currentPlayerId = (this.currentPlayerId + 1) % 4;

      return setTimeout(() => {
        player.disable();
        this.play();
      }, config.BOT_PLAY ? config.BOT_PLAY_DELAY : this.playDelay);
    }

    /**
     * Called as part of `play()` during the "draw one"
     * phase, this function simply gets a tile from the
     * wall, and then deals it to the indicated player.
     */
    async dealTile(player) {
      let wall = this.wall;
      let revealed = false;
      do {
        let tile = wall.get();
        let players = this.players;

        await players.asyncAll(p => p.receivedTile(player));

        console.debug(`${player.id} receives ${tile} - ${player.getTileFaces()}`);
        config.log(`${player.id} <  ${tile} - ${player.getTileFaces()} - PRNG: ${config.PRNG.seed()}`);
        revealed = player.append(tile);

        if (revealed) {
          await players.asyncAll(p => p.see(revealed, player));
        }

        else {
          let kong = await player.checkKong(tile);
          if (kong) {
            console.debug(`${player.id} plays self-drawn kong ${kong[0].getTileFace()} during play`);
            let claim = await this.processKong(player, kong);
            if (claim) return claim;
          }
        }
      } while (revealed);
    }

    /**
     * Called as part of `play()` during the "play one"
     * phase, this function is triggered when the player
     * opts _not_ to discard a tile, instead discarding
     * the value `undefined`. This signals that the player
     * has managed to form a winning hand during the
     * "draw on" phase of their turn, and we should
     * wrap up this hand of play, calculate the scores,
     * and schedule a call to `startHand` so that play
     * can move on to the next hand (or end, if this
     * was the last hand to be played and it resolved
     * in a way that would normally rotate the winds).
     */
    async processWin(player, discardpid) {
      let hand = this.hand;
      let players = this.players;
      let currentPlayerId = this.currentPlayerId;
      let windOfTheRound = this.windOfTheRound;

      player.markWinner();

      let play_length = (Date.now() - this.PLAY_START);
      let message = `Player ${currentPlayerId} wins hand ${hand}! (hand took ${play_length}ms)`;
      //console.log(message);
      config.log(message);

      // Let everyone know what everyone had. It's the nice thing to do.
      let fullDisclosure = players.map(p => p.getDisclosure());
      console.debug('disclosure array:', fullDisclosure);

      await players.asyncAll(p => p.endOfHand(fullDisclosure));

      // And od course, calculate the scores.
      console.debug("SCORING TILES");

      let scores = fullDisclosure.map((d,id) => this.rules.scoreTiles(d, id, windOfTheRound, this.wall.remaining));

      // In order to make sure payment is calculated correctly,
      // check which player is currently playing east, and then
      // ask the current ruleset to settle the score differences.
      let eastid = 0;

      // FIXME: TODO: can we get ths information async?
      players.forEach(p => { if(p.wind === 0) eastid = p.id; });

      let adjustments = this.rules.settleScores(scores, player.id, eastid, discardpid);

      await players.asyncAll(p => {
        config.log(`${p.id}: ${adjustments[p.id]}, hand: ${p.getTileFaces()}, [${p.getLockedTileFaces()}], (${p.bonus}), discards: ${fullDisclosure[p.id].discards}`);
        p.recordScores(adjustments);
      });

      // Before we move on, record this step in the game,
      // and show the score line in a dismissable modal.
      this.scoreHistory.push({ fullDisclosure, scores, adjustments });
      scores[player.id].winner = true;

      if (config.HAND_INTERVAL > 0) {
        // Start a new hand after the scoring modal gets dismissed.
        modal.setScores(hand, this.rules, scores, adjustments, () => {
          this.startHand({ winner: player });
        });
      } else this.startHand({ winner: player });
    }

    /**
     * Called as part of `play()` during the "play one"
     * phase, this function processes the discard as
     * declared by the current player. Note that this
     * function only deals with actual discards: if the
     * player opted not to discard because they were
     * holding a winning tile, this function is not called.
     */
    async processDiscard(player) {
      let discard = this.discard;
      console.debug(`${player.id} discarded ${discard.getTileFace()}`);
      config.log(`${player.id}  > ${discard.getTileFace()}`);
      player.remove(discard);
      discard.setFrom(player.id);
      discard.reveal();

      await this.players.asyncAll(p => p.playerDiscarded(player, discard, this.counter));
    }

    /**
     * Called as part of `play()` during the "play one"
     * phase, after `processDiscard()` takes place, this
     * function ask all players to state whether they are
     * interested in the discarded tile, and if so: what
     * kind of play they intend to make with that tile.
     *
     * This is asynchronous code in that all players are
     * asked to make their determinations simultaneously,
     * and the game is on hold until all claims (including
     * passes) are in.
     *
     * If there are multiple claims, claims are ordered
     * by value, and the higest claim "wins".
     */
    async getAllClaims() {
      await this.continue("getAllClaims");

      let players = this.players;
      let currentpid = this.currentPlayerId;
      let discard = this.discard;

      // get all players to put in a claim bid
      let claims = await Promise.all(
        players.map(p => new Promise(resolve => p.getClaim(currentpid, discard, this.wall.remaining, resolve)))
      );

      console.debug('all claims are in');

      let claim = CLAIM$1.IGNORE;
      let win = undefined;
      let p = -1;

      // Who wins the bidding war?
      claims.forEach((c,pid)=> {
        if (c.claimtype > claim) {
          claim = c.claimtype;
          win = c.wintype ? c.wintype : undefined;
          p = pid;
        }
      });

      // console.log(claims);

      // artificial delay, if required for human play
      if (currentpid===0 && !config.BOT_PLAY && config.BOT_DELAY_BEFORE_DISCARD_ENDS) {
        await new Promise( resolve => {
          setTimeout(() => resolve(), config.BOT_DELAY_BEFORE_DISCARD_ENDS);
        });
      }

      let winningClaim = (p === -1) ? undefined : { claimtype: claim, wintype: win, p };
      // console.log(winningClaim);
      return winningClaim;
    }

    /**
     * Called in `play()` during the "play one" phase, after
     * `getAllClaims()` resolves, this function schedules the
     * "recursive" call to `play()` with the winning claim
     * passed in, so that the next "draw one" resolves the
     * claim, instead of drawing a new tile from the wall.
     */
    processClaim(player, claim) {
      this.discard;
      //console.log(`${claim.p} wants ${discard.getTileFace()} for ${claim.claimtype}`);
      player.disable();
      setTimeout(() => this.play(claim), config.BOT_PLAY ? config.BOT_PLAY_DELAY : this.playDelay);
    }
  }

  /**
   * Nothing fancy here. Just a Game object builder.
   */
  class GameManager {
    constructor(players) {
      const wallHack = config.WALL_HACK;
      this.players = players || [
        new HumanPlayer(0, wallHack),
        new BotPlayer(1, wallHack),
        new BotPlayer(2, wallHack),
        new BotPlayer(3, wallHack),
      ];
    }

    /**
     * Create a game, with document blur/focus event handling
     * bound to game pause/resume functionality.
     */
    newGame() {
      let game = new Game(this.players);

      globalThis.currentGame = {
        game: game,
        players: this.players
      };

      let gameBoard = document.querySelector('.board');
      gameBoard.focus();

      return game;
    }
  }

  var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

  function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

  var webm = "data:video/webm;base64,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";
  var mp4 = "data:video/mp4;base64,AAAAHGZ0eXBNNFYgAAACAGlzb21pc28yYXZjMQAAAAhmcmVlAAAGF21kYXTeBAAAbGliZmFhYyAxLjI4AABCAJMgBDIARwAAArEGBf//rdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNDIgcjIgOTU2YzhkOCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMTQgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz02IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCB2YnZfbWF4cmF0ZT03NjggdmJ2X2J1ZnNpemU9MzAwMCBjcmZfbWF4PTAuMCBuYWxfaHJkPW5vbmUgZmlsbGVyPTAgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAFZliIQL8mKAAKvMnJycnJycnJycnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXiEASZACGQAjgCEASZACGQAjgAAAAAdBmjgX4GSAIQBJkAIZACOAAAAAB0GaVAX4GSAhAEmQAhkAI4AhAEmQAhkAI4AAAAAGQZpgL8DJIQBJkAIZACOAIQBJkAIZACOAAAAABkGagC/AySEASZACGQAjgAAAAAZBmqAvwMkhAEmQAhkAI4AhAEmQAhkAI4AAAAAGQZrAL8DJIQBJkAIZACOAAAAABkGa4C/AySEASZACGQAjgCEASZACGQAjgAAAAAZBmwAvwMkhAEmQAhkAI4AAAAAGQZsgL8DJIQBJkAIZACOAIQBJkAIZACOAAAAABkGbQC/AySEASZACGQAjgCEASZACGQAjgAAAAAZBm2AvwMkhAEmQAhkAI4AAAAAGQZuAL8DJIQBJkAIZACOAIQBJkAIZACOAAAAABkGboC/AySEASZACGQAjgAAAAAZBm8AvwMkhAEmQAhkAI4AhAEmQAhkAI4AAAAAGQZvgL8DJIQBJkAIZACOAAAAABkGaAC/AySEASZACGQAjgCEASZACGQAjgAAAAAZBmiAvwMkhAEmQAhkAI4AhAEmQAhkAI4AAAAAGQZpAL8DJIQBJkAIZACOAAAAABkGaYC/AySEASZACGQAjgCEASZACGQAjgAAAAAZBmoAvwMkhAEmQAhkAI4AAAAAGQZqgL8DJIQBJkAIZACOAIQBJkAIZACOAAAAABkGawC/AySEASZACGQAjgAAAAAZBmuAvwMkhAEmQAhkAI4AhAEmQAhkAI4AAAAAGQZsAL8DJIQBJkAIZACOAAAAABkGbIC/AySEASZACGQAjgCEASZACGQAjgAAAAAZBm0AvwMkhAEmQAhkAI4AhAEmQAhkAI4AAAAAGQZtgL8DJIQBJkAIZACOAAAAABkGbgCvAySEASZACGQAjgCEASZACGQAjgAAAAAZBm6AnwMkhAEmQAhkAI4AhAEmQAhkAI4AhAEmQAhkAI4AhAEmQAhkAI4AAAAhubW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAABDcAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAzB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+kAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAALAAAACQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPpAAAAAAABAAAAAAKobWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAB1MAAAdU5VxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACU21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAhNzdGJsAAAAr3N0c2QAAAAAAAAAAQAAAJ9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAALAAkABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALWF2Y0MBQsAN/+EAFWdCwA3ZAsTsBEAAAPpAADqYA8UKkgEABWjLg8sgAAAAHHV1aWRraEDyXyRPxbo5pRvPAyPzAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAeAAAD6QAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAAIxzdHN6AAAAAAAAAAAAAAAeAAADDwAAAAsAAAALAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAKAAAAiHN0Y28AAAAAAAAAHgAAAEYAAANnAAADewAAA5gAAAO0AAADxwAAA+MAAAP2AAAEEgAABCUAAARBAAAEXQAABHAAAASMAAAEnwAABLsAAATOAAAE6gAABQYAAAUZAAAFNQAABUgAAAVkAAAFdwAABZMAAAWmAAAFwgAABd4AAAXxAAAGDQAABGh0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAABDcAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAQkAAADcAABAAAAAAPgbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAC7gAAAykBVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAADi21pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAADT3N0YmwAAABnc3RzZAAAAAAAAAABAAAAV21wNGEAAAAAAAAAAQAAAAAAAAAAAAIAEAAAAAC7gAAAAAAAM2VzZHMAAAAAA4CAgCIAAgAEgICAFEAVBbjYAAu4AAAADcoFgICAAhGQBoCAgAECAAAAIHN0dHMAAAAAAAAAAgAAADIAAAQAAAAAAQAAAkAAAAFUc3RzYwAAAAAAAAAbAAAAAQAAAAEAAAABAAAAAgAAAAIAAAABAAAAAwAAAAEAAAABAAAABAAAAAIAAAABAAAABgAAAAEAAAABAAAABwAAAAIAAAABAAAACAAAAAEAAAABAAAACQAAAAIAAAABAAAACgAAAAEAAAABAAAACwAAAAIAAAABAAAADQAAAAEAAAABAAAADgAAAAIAAAABAAAADwAAAAEAAAABAAAAEAAAAAIAAAABAAAAEQAAAAEAAAABAAAAEgAAAAIAAAABAAAAFAAAAAEAAAABAAAAFQAAAAIAAAABAAAAFgAAAAEAAAABAAAAFwAAAAIAAAABAAAAGAAAAAEAAAABAAAAGQAAAAIAAAABAAAAGgAAAAEAAAABAAAAGwAAAAIAAAABAAAAHQAAAAEAAAABAAAAHgAAAAIAAAABAAAAHwAAAAQAAAABAAAA4HN0c3oAAAAAAAAAAAAAADMAAAAaAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAACMc3RjbwAAAAAAAAAfAAAALAAAA1UAAANyAAADhgAAA6IAAAO+AAAD0QAAA+0AAAQAAAAEHAAABC8AAARLAAAEZwAABHoAAASWAAAEqQAABMUAAATYAAAE9AAABRAAAAUjAAAFPwAABVIAAAVuAAAFgQAABZ0AAAWwAAAFzAAABegAAAX7AAAGFwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNTUuMzMuMTAw";

  // Detect iOS browsers < version 10


  var oldIOS = function oldIOS() {
    return typeof navigator !== "undefined" && parseFloat(("" + (/CPU.*OS ([0-9_]{3,4})[0-9_]{0,1}|(CPU like).*AppleWebKit.*Mobile/i.exec(navigator.userAgent) || [0, ""])[1]).replace("undefined", "3_2").replace("_", ".").replace("_", "")) < 10 && !window.MSStream;
  };

  // Detect native Wake Lock API support
  var nativeWakeLock = function nativeWakeLock() {
    return "wakeLock" in navigator;
  };

  var NoSleep = function () {
    function NoSleep() {
      var _this = this;

      _classCallCheck(this, NoSleep);

      this.enabled = false;
      if (nativeWakeLock()) {
        this._wakeLock = null;
        var handleVisibilityChange = function handleVisibilityChange() {
          if (_this._wakeLock !== null && document.visibilityState === "visible") {
            _this.enable();
          }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        document.addEventListener("fullscreenchange", handleVisibilityChange);
      } else if (oldIOS()) {
        this.noSleepTimer = null;
      } else {
        // Set up no sleep video element
        this.noSleepVideo = document.createElement("video");

        this.noSleepVideo.setAttribute("title", "No Sleep");
        this.noSleepVideo.setAttribute("playsinline", "");

        this._addSourceToVideo(this.noSleepVideo, "webm", webm);
        this._addSourceToVideo(this.noSleepVideo, "mp4", mp4);

        this.noSleepVideo.addEventListener("loadedmetadata", function () {
          if (_this.noSleepVideo.duration <= 1) {
            // webm source
            _this.noSleepVideo.setAttribute("loop", "");
          } else {
            // mp4 source
            _this.noSleepVideo.addEventListener("timeupdate", function () {
              if (_this.noSleepVideo.currentTime > 0.5) {
                _this.noSleepVideo.currentTime = Math.random();
              }
            });
          }
        });
      }
    }

    _createClass(NoSleep, [{
      key: "_addSourceToVideo",
      value: function _addSourceToVideo(element, type, dataURI) {
        var source = document.createElement("source");
        source.src = dataURI;
        source.type = "video/" + type;
        element.appendChild(source);
      }
    }, {
      key: "enable",
      value: function enable() {
        var _this2 = this;

        if (nativeWakeLock()) {
          return navigator.wakeLock.request("screen").then(function (wakeLock) {
            _this2._wakeLock = wakeLock;
            _this2.enabled = true;
            console.log("Wake Lock active.");
            _this2._wakeLock.addEventListener("release", function () {
              // ToDo: Potentially emit an event for the page to observe since
              // Wake Lock releases happen when page visibility changes.
              // (https://web.dev/wakelock/#wake-lock-lifecycle)
              console.log("Wake Lock released.");
            });
          }).catch(function (err) {
            _this2.enabled = false;
            console.error(err.name + ", " + err.message);
            throw err;
          });
        } else if (oldIOS()) {
          this.disable();
          console.warn("\n        NoSleep enabled for older iOS devices. This can interrupt\n        active or long-running network requests from completing successfully.\n        See https://github.com/richtr/NoSleep.js/issues/15 for more details.\n      ");
          this.noSleepTimer = window.setInterval(function () {
            if (!document.hidden) {
              window.location.href = window.location.href.split("#")[0];
              window.setTimeout(window.stop, 0);
            }
          }, 15000);
          this.enabled = true;
          return Promise.resolve();
        } else {
          var playPromise = this.noSleepVideo.play();
          return playPromise.then(function (res) {
            _this2.enabled = true;
            return res;
          }).catch(function (err) {
            _this2.enabled = false;
            throw err;
          });
        }
      }
    }, {
      key: "disable",
      value: function disable() {
        if (nativeWakeLock()) {
          if (this._wakeLock) {
            this._wakeLock.release();
          }
          this._wakeLock = null;
        } else if (oldIOS()) {
          if (this.noSleepTimer) {
            console.warn("\n          NoSleep now disabled for older iOS devices.\n        ");
            window.clearInterval(this.noSleepTimer);
            this.noSleepTimer = null;
          }
        } else {
          this.noSleepVideo.pause();
        }
        this.enabled = false;
      }
    }, {
      key: "isEnabled",
      get: function get() {
        return this.enabled;
      }
    }]);

    return NoSleep;
  }();

  var noSleepEnabled = false;

  // import { ClientUIMaster } from "../core/players/ui/client-ui-master.js";

  /**
   * This is the function that runs as the very first call
   * when the web page loads: do you want to play a game,
   * or do you want to watch the bots play each other?
   */
  (function () {
    // functions are always "hoisted" to above any
    // actual code, so the following lines work,
    // despite the functions being declared "later".
    if (config.PLAY_IMMEDIATELY) play();
    else offerChoice();

    // Forced bot play
    function play() {
      let manager = new GameManager();
      let game = manager.newGame();
      game.startGame(() => {
        document.body.classList.add("finished");
        let gameui = game.players.find((p) => p.ui).ui;
        config.flushLog();
        return modal.showFinalScores(
          gameui,
          game.rules,
          game.scoreHistory,
          () => {
            document.body.classList.remove("finished");
            rotateWinds.reset();
            offerChoice();
          }
        );
      });
    }

    // Optional bot play.
    function offerChoice() {
      const options = [
        { description: "There are currently two modes of play on offer:" },
        { label: "I'd like to play some mahjong!", value: "play" },
        { label: "I just want to watch the bots play", value: "watch" },
        {
          description: "Alternatively, you can modify the game settings:",
          align: "center",
        },
        { label: "Change settings", value: "settings", back: true },
        { label: "Change theming", value: "theming", back: true },
        {
          description: "(you can also open the settings during play)",
          align: "center",
        },
      ];
      options.fixed = true;
      modal.choiceInput(
        "Welcome! What would you like to do?",
        options,
        (result) => {
          config.BOT_PLAY = result === "watch";
          if (result === "watch") config.FORCE_OPEN_BOT_PLAY = true;
          if (result === "settings") return modal.pickPlaySettings();
          if (result === "theming") return modal.pickTheming();
          play();
        }
      );
    }
  })();

})();
