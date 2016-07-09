'use strict';
var crypto = require('crypto');
var debug = require('debug')('user');
var Sequelize = require('sequelize');

var sequelize = new Sequelize('database', 'username', 'password', {
  dialect: 'sqlite',
  pool: {
    max: 5,
    min: 0,
    idle: 10000
  },
  storage: 'users.sqlite'
});

var DEFAULT_GRAVATAR = '9a85e3d0-4233-11e6-bac0-4b263459491d';

/*
 * Add new properties to the flat schema
 */
var FLAT_SCHEMA = {
  id: {
    type: Sequelize.UUID,
    defaultValue: Sequelize.UUIDV1,
    primaryKey: true
  },
  revision: Sequelize.STRING,
  deleted: Sequelize.STRING,
  username: {
    type: Sequelize.STRING,
    unique: true
  },
  email: Sequelize.STRING,
  gravatar: {
    type: Sequelize.STRING,
    get: function() {
      var gravatar = this.getDataValue('gravatar');
      if (gravatar) {
        return gravatar;
      }
      var email = this.getDataValue('email') || this.getDataValue('id') || DEFAULT_GRAVATAR;
      return crypto.createHash('md5').update(email).digest('hex');
    },
  },
  description: Sequelize.TEXT,
  givenName: Sequelize.STRING,
  familyName: Sequelize.STRING,
  language: Sequelize.STRING
};

var User = sequelize.define('users', FLAT_SCHEMA);

/**
 * Convert an incoming json and scrubs it against the above SCHEMA
 * @param  {Object} json A user profile usually coming from the client side for example
 * @return {Object}      A flat representation of the user which can be saved in the db
 */
function jsonToFlat(json, defaultValue) {
  var flat = {};

  json.name = json.name || {};

  for (var attr in FLAT_SCHEMA) {
    if (!FLAT_SCHEMA.hasOwnProperty(attr)) {
      continue;
    }

    if (attr.indexOf('Name') > -1) {
      flat[attr] = json.name[attr] !== undefined && json.name[attr] !== null ?
        json.name[attr] : defaultValue;
    } else {
      flat[attr] = json[attr] !== undefined && json[attr] !== null ?
        json[attr] : defaultValue;
    }
  }

  // use autogenerated id
  if (!flat.id) {
    delete flat.id;
  }

  if (!flat.deleted) {
    flat.deleted = null;
  }

  return flat;
}

/**
 * Convert a flat object from the database to a Passport compatible
 * user profile
 * @param  {Object} flat A flat representation usualy from the db
 * @return {Object}      A Passport compatible representation of the user
 */
function flatToJson(flat, defaultValue) {
  var json = {
    name: {}
  };

  for (var attr in FLAT_SCHEMA) {
    if (!FLAT_SCHEMA.hasOwnProperty(attr)) {
      continue;
    }

    if (attr.indexOf('Name') > -1) {
      json.name[attr] = flat[attr] !== undefined && flat[attr] !== null ?
        flat[attr] : defaultValue;
    } else {
      json[attr] = flat[attr] !== undefined && flat[attr] !== null ?
        flat[attr] : defaultValue;
    }
  }

  if (!json.deleted) {
    json.deleted = null;
  }

  if (flat.createdAt) {
    json.createdAt = flat.createdAt;
  }

  if (flat.updatedAt) {
    json.updatedAt = flat.updatedAt;
  }

  return json;
}

function increaseRevision(revision) {
  var revisionNumber = parseInt(revision.split('-')[0], 10);
  return (revisionNumber + 1) + '-' + Date.now();
}

/**
 * Create a user in the database
 * @param  {User}   profile
 * @return {Promise}
 */
function create(profile, callback) {
  if (!profile || !profile.name) {
    return callback(new Error('Invalid user'));
  }

  var flat = jsonToFlat(profile);

  if (flat.revision) {
    if (flat.revision.indexOf('-') === -1) {
      delete flat.revision;
    } else {
      flat.revision = increaseRevision(flat.revision);
    }
  }
  flat.revision = flat.revision || '1-' + Date.now();

  User
    .create(flat)
    .then(function(data) {
      var flat = data.toJSON();
      callback(null, flatToJson(flat, ''));
    })
    .catch(callback);
}

/**
 * Create a user in the database
 * @param  {User}   profile
 * @return {Promise}
 */
function read(profile, callback) {
  User
    .find({
      where: {
        username: profile.username
      }
    })
    .then(function(dbUser) {
      if (!dbUser) {
        return callback(null, null);
      }
      callback(null, flatToJson(dbUser.toJSON(), ''));
    })
    .catch(callback);
}

/**
 * Verify a user in the database
 * @param  {User}   profile
 * @return {Promise}
 */
function verifyPassword(profile, callback) {
  User
    .find({
      where: {
        username: profile.username
      }
    })
    .then(function(dbUser) {
      if (!dbUser) {
        return callback(null, null);
      }
      // TODO salt and hash the password and check if it matches

      callback(null, flatToJson(dbUser.toJSON(), ''));
    })
    .catch(callback);
}

/**
 * Save a user in the database
 * @param  {User}   profile
 * @return {Promise}
 */
function save(profile, callback) {
  User
    .find({
      where: {
        username: profile.username
      }
    })
    .then(function(dbUser) {
      // Create the user
      if (!dbUser) {
        return create(profile, callback);
      }

      var flat = jsonToFlat(profile, 'not:::patched');
      debug(flat);

      // Update only the changed fields
      for (var attr in flat) {
        if (flat.hasOwnProperty(attr) && flat[attr] !== 'not:::patched') {
          dbUser.set(attr, flat[attr]);
          debug('setting ', attr);
        }
      }

      dbUser.set('revision', increaseRevision(dbUser.get('revision')));

      return dbUser
        .save()
        .then(function(savedDbUser) {
          debug(savedDbUser);
          if (!savedDbUser) {
            return callback(new Error('Unable to save the user.'));
          }

          callback(null, flatToJson(savedDbUser.toJSON(), ''));
        })
        .catch(callback);
    })
    .catch(callback);
}

/**
 * List users matching the options
 * @param  {String} options [description]
 * @return {Promise}        [description]
 */
function list(options, callback) {
  options = options || {};
  options.limit = options.limit || 10;
  options.offset = options.offset || 0;
  options.where = options.where || {
    deleted: null
  };

  options.attributes = ['id', 'username', 'gravatar'];

  User
    .findAll(options)
    .then(function(users) {
      if (!users) {
        return callback(new Error('Unable to fetch user collection'));
      }

      callback(null, users.map(function(dbUser) {
        return dbUser.toJSON();
      }));
    })
    .catch(callback);
}

/**
 * Delete users matching the options
 * @param  {String} options [description]
 * @return {Promise}        [description]
 */
function flagAsDeleted() {
  throw new Error('Unimplemented');
}

/**
 * Initialize the table if not already present
 * @return {Promise}        [description]
 */
function init() {
  return sequelize.sync();
}

module.exports.create = create;
module.exports.flagAsDeleted = flagAsDeleted;
module.exports.init = init;
module.exports.list = list;
module.exports.save = save;
module.exports.read = read;
module.exports.verifyPassword = verifyPassword;
module.exports.serialization = {
  flatToJson: flatToJson,
  jsonToFlat: jsonToFlat
};
