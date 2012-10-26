/*
  This file is part of Quirky.

  Quirky is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  Quirky is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with Quirky.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * @fileoverview Quirky node server
 * @author juan.lasheras@gmail.com (Juan Lasheras)
 */

http = require('http');
url = require('url');
querystring = require('querystring');
fs = require('fs');

cookies = require('./node_modules/cookies');

var static_files = {
    'index': fs.readFileSync('index.html'),
    'game-client.js': fs.readFileSync('game-client.js'),
    'layout.css': fs.readFileSync('layout.css'),
    'color.css': fs.readFileSync('color.css'),
    'typography.css': fs.readFileSync('typography.css'),
    'normalize.css': fs.readFileSync('normalize.css'),
    'jquery.min.js': fs.readFileSync('jquery/jquery.min.js'),
    'jquery-ui.min.js': fs.readFileSync('jquery/jquery-ui.min.js'),
    'jquery.cookie.js': fs.readFileSync('jquery/jquery.cookie.js'),
    'light_noise_diagonal.png': fs.readFileSync("media/light_noise_diagonal.png"),
    'wood.png': fs.readFileSync("media/dark_wood.png")
}

var CHATLINES = 1000;  // number of lines to store from chats

function Game (name) {
    this.name = name;
    this.board = [];  // list representation
    this.boardmat = [];  // matrix representation
    for (var i=0; i<181; i++)
        this.boardmat[i] = new Array(181);
    this.pieces = [];
    this.players = {};
    this.turn_pieces = [];  // pieces played this turn
    this.chat = []  // chat log

    // board dimensions
    this.dimensions = {'top': 90, 'right': 90, 'bottom': 90, 'left': 90};

    var colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
    var shapes =  ['circle', 'star', 'diamond', 'square', 'triangle', 'clover'];
    for (c in colors)
        for (s in shapes)
            this.pieces.push({'piece': new Piece(shapes[s], colors[c]), 'count': 3});
}

Game.prototype.toJSON = function() {
    return {'name': this.name, 'players': this.players};
}

Game.prototype.drawPieces = function(num) {
    // draw num pieces from the pile
    var draw = [];
    while (draw.length < num && this.pieces.length > 0) {
        var r = Math.floor(Math.random() * this.pieces.length);
        var p = this.pieces[r]['piece'];
        draw.push(new Piece(p.shape, p.color));
        if ((this.pieces[r]['count'] -= 1) < 1)
            this.pieces.splice(r, 1)
    }
    return draw;
}

function Player (name) {
    this.name = name;
    this.pieces = [];
    this.points = 0;
    this.has_turn = false;
}

function Piece (shape, color) {
    this.shape = shape;
    this.color = color;
    this.equals = function(x) {
        return (this.shape == x.shape && this.color == x.color);
    }
}

function GamePiece (piece, row, column) {
    this.piece = piece;
    this.row = row;
    this.column = column;
    this.equals = function(x) {
        return (this.column == x.column && this.row == x.row &&
                this.piece.equals(x.piece))
    }
}

// typical response helper
function respOk (response, data, type) {
    if (type)
        headers = {'Content-Type': type};
    response.writeHead(200, headers);
    if (data)
        response.write(data, 'utf-8');
    response.end();
}

/**
 * Add a game piece to the board, check that:
 *  1. game piece doesn't already exist
 *  2. game piece is not adjacent to non-compatible piece
 * return: integer of points if Success, otherwise return an error string
 */
function addGamePiece(game, gamepiece) {

    var row = gamepiece.row;
    var col = gamepiece.column;
    var points = 0;

    if (typeof game.boardmat[row][col] !== "undefined")
        return "GamePiece already exists.";

    /**
     * Helper function, to check whether it is valid to place a piece
     * param piece: the piece object being placed
     * param getAdjacent: a function that returns an adjacent GamePiece
     * return: false if valid placement, otherwise return the offending GamePiece
     */
    function _adjacentPieces(piece, getAdjacent) {
        for (var i=1; i<=6; i++) {
            adjacent = getAdjacent(i);
            if (typeof adjacent === 'undefined')
                return false;
            else if (i == 6)  // can't have more than 6 pieces in a valid line
                return adjacent;

            var samecolor = (adjacent.piece.color == piece.color);
            var sameshape = (adjacent.piece.shape == piece.shape);

            console.log('piece: ' + piece.color + ' ' + piece.shape +
                        ', adjacent: ' + adjacent.piece.color + ' ' +
                        adjacent.piece.shape);

            // either samecolor or sameshape, not both
            if ((samecolor || sameshape) && !(samecolor && sameshape)) {
                // add a point for adjacent piece, if not been played this turn
                if (!game.turn_pieces.some(function(x){
                    return x.equals(adjacent);}))
                    points += 1;
                continue;
            }
            return adjacent;
        }
        return false;
    }

    // check if adjacent pieces are compatible
    var checkLeft = _adjacentPieces(gamepiece.piece, function(offset) {
        var _row = row-offset;
        var piece = game.boardmat[_row][col];
        return piece && new GamePiece(piece, _row, col)});
    var checkRight =_adjacentPieces(gamepiece.piece, function(offset) {
        var _row = row+offset;
        var piece = game.boardmat[_row][col];
        return piece && new GamePiece(piece, _row, col)});
    var checkUp =_adjacentPieces(gamepiece.piece, function(offset) {
        var _col = col-offset;
        var piece = game.boardmat[row][_col];
        return piece && new GamePiece(piece, row, _col)});
    var checkDown =_adjacentPieces(gamepiece.piece, function(offset) {
        var _col = col+offset;
        var piece = game.boardmat[row][_col];
        return piece && new GamePiece(piece, row, _col)});
    var badPiece = false;
    if (badPiece = (checkLeft || checkRight || checkUp || checkDown))
        return ("GamePiece adjacent to incompatible piece: " +
                badPiece.piece.color + " " + badPiece.piece.shape);

    // check if piece played in same row or column as past pieces this turn}
    function sameRowOrCol(otherpiece) {
        return (otherpiece.row == row || otherpiece.column == col)
    }
    if (game.turn_pieces)
        if (!game.turn_pieces.every(sameRowOrCol))
            return ("GamePiece must be in same row or column as others " +
                    "placed this turn.");

    game.turn_pieces.push(gamepiece);
    game.boardmat[row][col] = gamepiece.piece;
    game.board.push(gamepiece);

    // update board dimensions
    var dim = game.dimensions;
    if (col < dim.left)
        dim.left = col;
    else if (col > dim.right)
        dim.right = col;
    if (row < dim.top)
        dim.top = row;
    else if (row > dim.bottom)
        dim.bottom = row;

    // debug logging, print out boardmat
    // for (var i=dim.top; i<=dim.bottom; i++) {
    //  for (var j=dim.left; j<=dim.right; j++) {
    //      var piecestr = (typeof game.boardmat[i][j] == "undefined") ? " ":
    //          game.boardmat[i][j];
    //      process.stdout.write('['+piecestr+']');
    //  }
    //  console.log('');
    // }

    return points+1;  // get one point for placing a piece
}

// find player from request cookie
function playerFromReq(request, response, game) {
    var jar = new cookies(request, response);
    var p = jar.get('player');
    return game.players[p];
}

// extract data from query string
function requestQuery(request) {
    return querystring.parse(url.parse(request.url).query);
}

// extract data from request body and pass to onEnd functon
function requestBody(request, onEnd) {
    var fullBody = '';
    request.on('data', function(d) {fullBody += d.toString()});
    request.on('end', function() {
        onEnd(querystring.parse(fullBody));
    });
}

/**
 * End the turn for the player and start for the next.
 * @param {obj} player: the player whose turn will end
 */
function switchPlayers(game, player) {
    player.has_turn = false;

    // clear pieces played this turn
    game.turn_pieces = [];

    // give next player the turn
    var _players = Object.keys(game.players);
    var next_idx = (_players.indexOf(player['name']) + 1) %
        _players.length;
    var next = game.players[_players[next_idx]];
    next.has_turn = true;

    // draw new pieces
    next.pieces = next.pieces.concat(game.drawPieces(
        6 - next.pieces.length));
}

/**
 * Handle a player resource transaction.
 * - POST to add player to the game.
 * - GET player pieces
 */
function handlePlayers(request, response, game, path) {

    if (!path.length) {
        // return info on the players collection

        if (request.method == "POST") {
            var player = playerFromReq(request, response, game);
            if (player)
                // end turn
                // TODO should this be under /players/<name>/?
                var func = function (form) {
                    if (form && form.end_turn) {
                        switchPlayers(game, player);
                        respOk(response);
                    }
                }
            else
                // add player
                var func = function(form) {
                    if (form && form.name) {
                        var p = new Player(form.name);
                        p.pieces = game.drawPieces(6);
                        game.players[p.name] = p;

                        // if first player, make it his turn
                        if (Object.keys(game.players).length == 1)
                            p.has_turn = true;

                        // TODO replace set cookie with cookie API?
                        response.writeHead(200,{
                            'Content-Type': 'text/json',
                            "Set-Cookie": ["player="+form.name+"; Path=/"]
                        });
                        response.end();
                    }
                }
            requestBody(request, func);
            return;
        }
        else
            var r = JSON.stringify(game.players);

    } else {
        // return info on a specific player

        var player = game.players[path[0]];

        if (typeof player === 'undefined') {
            // player not found
            response.writeHead(404, {'Content-Type': 'text/json'});
            response.end();
            return;
        }

        switch(path[1]) {
        case 'pieces':
            var r = JSON.stringify(player.pieces);
        }
    }
    respOk(response, r, 'text/json');
}

/**
 * Handle a game resource transaction.
 * - POST to add piece to the board.
 * - Forward player transactions to separate function.
 * - GET pieces on board & in bag
 * - GET dimensions
 */
function handleGame(request, response, game, path) {
    switch(path[0]) {
    case 'board':
        // add pieces to the board
        if (request.method == "POST") {
            requestBody(request, function(form) {

                var player = playerFromReq(request, response, game);
                console.info('adding pieces, player:'+player.name);
                console.info('form info:'+JSON.stringify(form));

                if (form && form.shape && form.color &&
                    form.row && form.column && player) {

                    // TODO should do form check?
                    var row = parseInt(form.row);
                    var column = parseInt(form.column);
                    var piece = new Piece(form.shape, form.color);

                    // check player has piece
                    var idx = -1, _idx = 0;
                    for (var p in player.pieces) {
                        var _piece = player.pieces[p];
                        //console.log('check:'+JSON.stringify(p)+', and:'+
                        //          JSON.stringify(piece));
                        if (piece.equals(_piece)) {
                            idx = _idx;
                            break;
                        }
                        _idx += 1;
                    }

                    if (idx > -1) {
                        var gp = new GamePiece(piece, row, column);
                        console.info('adding piece:'+JSON.stringify(gp));
                        var resp = addGamePiece(game, gp);
                        if (typeof resp === "string") {
                            // add gamepiece failed
                            response.writeHead(409, {'Content-Type': 'text/json'});
                            response.write(resp, 'utf-8');
                            response.end();
                            return;
                        } else {
                            // add gamepiece succeeded
                            player.points += resp;
                            player.pieces.splice(idx, 1);
                            respOk(response, '', 'text/json');
                        }
                    }
                }
            });
            return;
        }
        // get pieces on the board
        var r = JSON.stringify(game.board);
        break;
    case 'players':
        handlePlayers(request, response, game, path.slice(1));
        return;
    case 'pieces':
        // get pieces in the bag
        var r = JSON.stringify(game.pieces);
        break;
    case 'chat':
        handleChat(request, response, game.chat);
        break;
    case 'dimensions':
        var r = JSON.stringify(game.dimensions);
    }
    respOk(response, r, 'text/json');
}

/**
 * Handle transaction on game collection resource.
 */
function handleGames(request, response, path) {
    if (!path.length) {
        if (request.method == "POST") {
            // add a new game object
            requestBody(request, function(form) {
                var gamenm = form.name;
                while (games[gamenm])  // game already exists
                    gamenm = gamenm+Math.floor(Math.random()*10);
                games[gamenm] = new Game(gamenm);
                respOk(response, '', 'text/json');
            });
        } else {
            // return info on the games collection
            var r = JSON.stringify(games);
            respOk(response, r, 'text/json');
        }
    } else {
        // return info on a specifc game
        var game = games[path.shift()];
        handleGame(request, response, game, path);
    }
}

/**
 * Handle transaction on chat.
 * @param chat {list}: a chat object, which is a list of
 *    {id: {number}, name: {string}, input: {string}} objects
 */
function handleChat(request, response, chat) {
    if (request.method == "POST") {
        // add a line to the chat log
        requestBody(request, function(form) {
            while (chat.length > CHATLINES)
                chat.shift();

            /* If data is present in the chat, then increment the last id,
             * otherwise start at 0.
             */
            if (chat.length)
                var id = chat[chat.length-1]['id']+1;
            else
                var id = 0;
            chat.push({
                id: id,  // chat line id
                name: form.name,  // the user's name
                input: form.input  // the user's text input
            });
            respOk(response, '', 'text/json');
        });
    } else {
        /* Return chat data. If lastid is specified, then we only return
         * chat lines since this id.
         */
        var form = requestQuery(request);
        var lastid = +form.lastid;
        if (lastid >= 0) {
            for (var i=0; i<chat.length; i++) {
                if (chat[i]['id'] == lastid)
                    break;
            }
            var r = JSON.stringify(chat.slice(i+1));
        } else {
            var r = JSON.stringify(chat);
        }
        respOk(response, r, 'text/json');
    }
}

var chat = [];
var games = {};
var server = http.createServer();

server.on('request', function(request, response) {

    //console.log('got request:'+JSON.stringify(request.headers));

    var u = url.parse(request.url);
    var path = u.pathname.split('/').filter(function(x) {return Boolean(x)});
    //console.log('req headers:'+JSON.stringify(request.headers));
    //console.log('got path:'+JSON.stringify(path));

    switch(path[0]) {
    case 'games':
        handleGames(request, response, path.slice(1));
        break;
    case 'chat':
        handleChat(request, response, chat);
        break;
    default:
        var f;
        if (f = static_files[path[0]]) {
            var type = 'text/html';
            if (path[0].search('css$') >= 0)
                type = 'text/css';
            else if (path[0].search('js$') >= 0)
                type = 'text/javascript';
            respOk(response, f, type);
        }
        break;
    }
});

var port = process.env.PORT || 8010;
server.listen(port);
