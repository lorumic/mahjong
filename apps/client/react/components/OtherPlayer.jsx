var React = require('react');
var Tile = require('../components/Tile.jsx');
var Tiles = require('../../../server/lib/game/tiles');
var Constants = require('../../../server/lib/constants');
var classnames = require('classnames');

var OtherPlayer = React.createClass({

  getInitialState() {
    return {
      tiles: [],
      bonus: [],
      revealed: [],
      turn: this.props.turn
    };
  },

  reset: function(prevProps, prevState) {
    this.setState(this.getInitialState());
  },

  componentDidMount() {
    var socket = this.props.socket;
    socket.on("dealt", this.addTiles);
    socket.on("tile", this.otherPlayerTile);
    socket.on("drew", this.addTile);
    socket.on("compensated", this.addBonus);
    socket.on("discarded", this.removeTile);
    socket.on("revealed", this.revealedSet);
  },

  formTiles(tiles, sets) {
    return tiles.map((t,p) => {
      if (!sets) {
        var title = t!=="concealed" ? Tiles.getTileName(t) : "another player's tile";
        return <Tile key={t+'-'+p} value={t} title={title} />;
      }
      return t.map((t,p) => {
        return <Tile key={t+'-'+p} value={t} title={Tiles.getTileName(t)} />;
      });
    });
  },

  render() {
    var className = classnames("otherplayer", {
      ourturn: this.state.ourTurn
    });

    return (
      <div className={className}>
      <span className="name">{this.props.label}</span>
      <span className="tiles">{this.formTiles(this.state.tiles)}</span>
      <span className="revealed">{this.formTiles(this.state.revealed,true)}</span>
      <span className="bonus">{this.formTiles(this.state.bonus)}</span>
      </div>
    );
  },

  ours(data) {
    return (data.playerposition === this.props.playerposition);
  },

  addTiles(data) {
    if(!this.ours(data)) return;
    var tiles = this.state.tiles;
    var num = data.tileCount;
    while(num--) { tiles.push('concealed'); }
    this.setState({ tiles });
  },

  otherPlayerTile(data) {
    this.setState({ ourTurn: false });
  },

  addTile(data) {
    if(!this.ours(data)) {
      this.setState({ ourTurn: false });
      return;
    }
    var tiles = this.state.tiles;
    tiles.push('concealed');
    this.setState({ tiles, ourTurn: true });
  },

  addBonus(data) {
    if(!this.ours(data)) return;
    var bonus = this.state.bonus.concat(data.tiles);
    this.setState({ bonus });
  },

  removeTile(data) {
    if(!this.ours(data)) return;
    var tiles = this.state.tiles;
    tiles.pop();
    this.setState({ tiles });
  },

  revealedSet(data) {
    if(!this.ours(data)) return;
    var playerpos = data.playerposition;
    var revealedSet = data.revealed;
    var revealed = this.state.revealed;
    revealed.push(revealedSet);
    var tiles = this.state.tiles;
    tiles.splice(0, revealedSet.length-1);
    this.setState({ tiles, revealed });
  }

});

module.exports = OtherPlayer;